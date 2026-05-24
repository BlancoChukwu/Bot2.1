import type { Address } from "viem";
import type { AaveV3Protocol, LiquidationCandidate } from "../protocols/aaveV3";
import {
  evaluateDustFilter,
  logLiquidationDustDecision,
  type DustFilterInput,
} from "../protocols/liquidationCandidateFilter";
import { calculateLiquidationEv } from "../utils/evCalculator";

export interface MonitorLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface HealthFactorMonitorConfig {
  readonly protocol: AaveV3Protocol;
  readonly pollIntervalMs: number;
  readonly candidateCooldownMs: number;
  readonly minProfitUsd: number;
  readonly gasCostUsd: number;
  readonly resolveDynamicGasCostUsd?: () => Promise<number>;
  readonly slippageBps: number;
  readonly resolveDynamicSlippageBps?: () => Promise<number>;
  readonly onReserveDataUpdated?: (reserve?: Address) => void;
  readonly minLiquidationDebtUsd?: number;
  readonly resolveDebtUsd?: (candidate: LiquidationCandidate) => Promise<number>;
  readonly logger: MonitorLogger;
}

const liquidationHealthFactor = 1_000_000_000_000_000_000n;

export class HealthFactorMonitor {
  private readonly lastCandidateAt = new Map<string, number>();
  private reserveSubscriptionStop: (() => void) | undefined;
  private lastScanStats = { scanned: 0, liquidatable: 0 };

  public constructor(private readonly config: HealthFactorMonitorConfig) {}

  public async scanOnce(now = Date.now()): Promise<LiquidationCandidate[]> {
    const gasCostUsd = await this.resolveGasCostUsd();
    const slippageBps = await this.resolveSlippageBps();
    const positions = await this.config.protocol.getLiquidatablePositions();
    const candidates: LiquidationCandidate[] = [];
    for (const position of positions) {
      if (await this.isExecutableCandidate(position, now, gasCostUsd, slippageBps)) {
        candidates.push(position);
      }
    }
    const stats = this.config.protocol.getLastScanStats?.() ?? {
      scanned: positions.length,
      liquidatable: positions.length,
    };
    this.lastScanStats = stats;

    for (const candidate of candidates) {
      this.lastCandidateAt.set(this.candidateKey(candidate), now);
    }

    this.config.logger.info("health_factor_scan_complete", {
      scanned: stats.scanned,
      liquidatable: candidates.length,
    });

    return candidates;
  }

  public getLastScanStats(): { scanned: number; liquidatable: number } {
    return this.lastScanStats;
  }

  public async startReserveDataUpdatedSubscription(): Promise<void> {
    if (this.reserveSubscriptionStop !== undefined) {
      return;
    }

    this.reserveSubscriptionStop = await this.config.protocol.subscribeToReserveDataUpdated?.((reserve) => {
      this.config.logger.info("reserve_data_updated_event", { reserve });
      this.config.onReserveDataUpdated?.(reserve);
    });
  }

  public stopReserveDataUpdatedSubscription(): void {
    this.reserveSubscriptionStop?.();
    this.reserveSubscriptionStop = undefined;
  }

  private async isExecutableCandidate(
    candidate: LiquidationCandidate,
    now: number,
    gasCostUsd: number,
    slippageBps: number,
  ): Promise<boolean> {
    if (candidate.healthFactor >= liquidationHealthFactor || this.isCoolingDown(candidate, now)) {
      return false;
    }

    if (this.config.minLiquidationDebtUsd !== undefined) {
      const debtUsd = this.config.resolveDebtUsd === undefined
        ? candidate.repayValueUsd
        : await this.config.resolveDebtUsd(candidate);
      const dust = evaluateDustFilter({
        debtUsd,
        minDebtUsd: this.config.minLiquidationDebtUsd,
        gasCostUsd,
      } satisfies DustFilterInput);
      logLiquidationDustDecision(this.config.logger, {
        chain: "monitor",
        account: candidate.account,
        debtAsset: candidate.debtAsset,
        collateralAsset: candidate.collateralAsset,
        stage: "health_factor_scan",
        decision: dust,
        minDebtUsd: this.config.minLiquidationDebtUsd,
      });
      if (dust.isDust) {
        return false;
      }
    }

    const ev = calculateLiquidationEv({
      repayValueUsd: candidate.repayValueUsd,
      liquidationBonusBps: candidate.liquidationBonusBps,
      gasCostUsd,
      slippageBps,
      minProfitUsd: this.config.minProfitUsd,
    });

    return ev.isProfitable;
  }

  private isCoolingDown(candidate: LiquidationCandidate, now: number): boolean {
    const lastSeen = this.lastCandidateAt.get(this.candidateKey(candidate));
    return lastSeen !== undefined && now - lastSeen < this.config.candidateCooldownMs;
  }

  private candidateKey(candidate: LiquidationCandidate): string {
    return `${candidate.account}:${candidate.collateralAsset}:${candidate.debtAsset}`;
  }

  private async resolveGasCostUsd(): Promise<number> {
    if (this.config.resolveDynamicGasCostUsd === undefined) {
      return this.config.gasCostUsd;
    }
    try {
      const resolved = await this.config.resolveDynamicGasCostUsd();
      return Number.isFinite(resolved) && resolved >= 0 ? resolved : this.config.gasCostUsd;
    } catch (error) {
      this.config.logger.warn("dynamic_gas_cost_resolution_failed", { error: String(error) });
      return this.config.gasCostUsd;
    }
  }

  private async resolveSlippageBps(): Promise<number> {
    if (this.config.resolveDynamicSlippageBps === undefined) {
      return this.config.slippageBps;
    }
    try {
      const resolved = await this.config.resolveDynamicSlippageBps();
      return Number.isFinite(resolved) && resolved >= 0 ? resolved : this.config.slippageBps;
    } catch (error) {
      this.config.logger.warn("dynamic_slippage_resolution_failed", { error: String(error) });
      return this.config.slippageBps;
    }
  }
}
