import type { Address, PublicClient } from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";
import type { BotMetrics, LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";
import { FixedSizeDedupe } from "../utils/fixedSizeDedupe";
import { extractBorrowerAddressesFromLog } from "./borrowerLogExtract";

const POOL_EVENTS = ["Borrow", "Repay", "LiquidationCall", "ReserveDataUpdated"] as const;
const POLL_MS = 200;

export interface FlashblocksPendingLogSourceConfig {
  readonly chain: SupportedChain;
  readonly poolAddress: Address;
  readonly client: PublicClient;
  readonly logger: LoggerLike;
  readonly metrics?: BotMetrics;
  readonly onPriorityAccounts: (accounts: readonly Address[]) => void;
  readonly onReserveUpdated?: (reserve: Address) => void;
}

/**
 * Polls pending-tag logs on a Flashblocks-capable endpoint (~200ms cadence).
 * Highest-priority path: bypasses 60s safety sweep for touched accounts.
 */
export class FlashblocksPendingLogSource {
  private timer: NodeJS.Timeout | undefined;
  private readonly dedupe = new FixedSizeDedupe(1_000);

  public constructor(private readonly config: FlashblocksPendingLogSourceConfig) {}

  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollPending().catch((error) => {
        this.config.logger.warn("flashblocks_pending_poll_failed", {
          chain: this.config.chain,
          error: String(error),
        });
      });
    }, POLL_MS);
    this.timer.unref?.();
    this.config.logger.info("flashblocks_pending_log_source_started", {
      chain: this.config.chain,
      pollMs: POLL_MS,
    });
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.dedupe.clear();
  }

  private async pollPending(): Promise<void> {
    const startedAt = Date.now();
    let logs: readonly unknown[] = [];
    try {
      logs = await this.config.client.getLogs({
        address: this.config.poolAddress,
        events: POOL_EVENTS.map((name) =>
          aavePoolAbi.find((item) => item.type === "event" && item.name === name),
        ).filter((item): item is NonNullable<typeof item> => item !== undefined),
        fromBlock: "pending",
        toBlock: "pending",
      });
    } catch {
      return;
    }

    const accounts = new Set<Address>();
    for (const log of logs) {
      const shaped = log as {
        readonly transactionHash?: string;
        readonly logIndex?: number;
        readonly args?: {
          readonly user?: Address;
          readonly onBehalfOf?: Address;
          readonly reserve?: Address;
        };
      };
      const key = `${shaped.transactionHash ?? "na"}-${String(shaped.logIndex ?? "na")}`;
      if (!this.dedupe.add(key)) {
        continue;
      }
      for (const user of extractBorrowerAddressesFromLog(shaped as never)) {
        accounts.add(user);
      }
      const reserve = shaped.args?.reserve;
      if (reserve !== undefined) {
        this.config.onReserveUpdated?.(reserve);
      }
    }

    if (accounts.size > 0) {
      this.config.onPriorityAccounts([...accounts]);
    }
    this.config.metrics?.recordPipelineLatency("flashblocks_lead_ms", Date.now() - startedAt, {
      chain: this.config.chain,
      provider: "flashblocks",
      flashblocks: "enabled",
    });
  }
}
