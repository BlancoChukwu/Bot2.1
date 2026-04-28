import type { AaveV3Protocol, LiquidationCandidate } from "../protocols/aaveV3";
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
  readonly slippageBps: number;
  readonly logger: MonitorLogger;
}

const liquidationHealthFactor = 1_000_000_000_000_000_000n;

export class HealthFactorMonitor {
  private readonly lastCandidateAt = new Map<string, number>();
  private reserveSubscriptionStop: (() => void) | undefined;
  private lastScanStats = { scanned: 0, liquidatable: 0 };

  public constructor(private readonly config: HealthFactorMonitorConfig) {
    if (config.pollIntervalMs !== 400) {
      throw new Error("pollIntervalMs must be exactly 400ms");
    }
  }

  public async scanOnce(now = Date.now()): Promise<LiquidationCandidate[]> {
    const positions = await this.config.protocol.getLiquidatablePositions();
    const candidates = positions.filter((position) => this.isExecutableCandidate(position, now));
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

    this.reserveSubscriptionStop = await this.config.protocol.subscribeToReserveDataUpdated?.(() => {
      this.config.logger.info("reserve_data_updated_event");
    });
  }

  public stopReserveDataUpdatedSubscription(): void {
    this.reserveSubscriptionStop?.();
    this.reserveSubscriptionStop = undefined;
  }

  private isExecutableCandidate(candidate: LiquidationCandidate, now: number): boolean {
    if (candidate.healthFactor >= liquidationHealthFactor || this.isCoolingDown(candidate, now)) {
      return false;
    }

    const ev = calculateLiquidationEv({
      repayValueUsd: candidate.repayValueUsd,
      liquidationBonusBps: candidate.liquidationBonusBps,
      gasCostUsd: this.config.gasCostUsd,
      slippageBps: this.config.slippageBps,
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
}
