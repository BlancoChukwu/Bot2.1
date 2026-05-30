import type { Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";

export interface FlashblockPrimaryLoopConfig {
  readonly chain: SupportedChain;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly intervalMs?: number;
  readonly providerLabel?: string;
  readonly runCycle: () => Promise<void>;
  readonly getOraclePricesUsdRaw?: () => Promise<Partial<Record<Address, bigint>>>;
  readonly oracleDeltaAlertPct?: number;
}

export class FlashblockPrimaryLoop {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private flashblockIndex = 0;
  private previousOraclePrices = new Map<Address, bigint>();

  public constructor(private readonly config: FlashblockPrimaryLoopConfig) {}

  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    const intervalMs = this.config.intervalMs ?? 200;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.config.logger.info("flashblock_primary_loop_started", {
      chain: this.config.chain,
      intervalMs,
    });
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    const startedAt = Date.now();
    this.flashblockIndex += 1;
    try {
      await this.updateOracleDelta();
      await this.config.runCycle();
      this.config.metrics.recordPipelineLatency("flashblock_to_detection_ms", Date.now() - startedAt, {
        chain: this.config.chain,
        provider: this.config.providerLabel ?? "flashblocks_primary_loop",
        flashblocks: "enabled",
      });
    } catch (error) {
      this.config.metrics.recordError();
      this.config.logger.warn("flashblock_primary_loop_tick_failed", {
        chain: this.config.chain,
        flashblockIndex: this.flashblockIndex,
        error: String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }

  private async updateOracleDelta(): Promise<void> {
    if (this.config.getOraclePricesUsdRaw === undefined) {
      return;
    }
    const prices = await this.config.getOraclePricesUsdRaw();
    for (const [token, price] of Object.entries(prices) as [Address, bigint][]) {
      const previous = this.previousOraclePrices.get(token);
      this.previousOraclePrices.set(token, price);
      if (previous === undefined || previous <= 0n) {
        continue;
      }
      const deltaPct = Number((abs(price - previous) * 10_000n) / previous) / 100;
      this.config.metrics.setOracleDeltaPct(this.config.chain, token, deltaPct);
      const alertPct = this.config.oracleDeltaAlertPct ?? 0.5;
      if (deltaPct > alertPct) {
        this.config.logger.warn("flashblock_oracle_delta_alert", {
          chain: this.config.chain,
          token,
          deltaPct,
          thresholdPct: alertPct,
        });
      }
    }
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

