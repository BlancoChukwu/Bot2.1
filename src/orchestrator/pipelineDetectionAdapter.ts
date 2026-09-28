import type { LoggerLike } from "../bot";
import type { HealthFactorMonitor } from "../monitors/healthFactorMonitor";
import type { BorrowerSnapshotProvider, HybridDetectionPipeline } from "../monitors/hybridDetectionPipeline";
import { ArbitrageOpportunityQueue } from "../monitors/arbitrageOpportunityQueue";
import { ReserveAwareBorrowerCache } from "../monitors/reserveAwareBorrowerCache";
import type { CircuitBreakerName, CircuitBreakerState } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { Opportunity } from "../types/opportunity";
import { fromArbitrageOpportunity } from "../types/opportunity";

export interface PipelineDetectionAdapterConfig {
  readonly chain: SupportedChain;
  readonly monitor?: HealthFactorMonitor;
  readonly hybridDetection?: HybridDetectionPipeline;
  readonly arbitrageQueue: ArbitrageOpportunityQueue;
  readonly enableArbitrage?: boolean;
  /** Resolves real per-reserve positions + debtToCover for monitor-scan accounts (no static-pair fallback). */
  readonly snapshotProvider?: Pick<BorrowerSnapshotProvider, "refreshBorrowers">;
  readonly logger?: LoggerLike;
}

export class PipelineDetectionAdapter {
  public readonly cache: ReserveAwareBorrowerCache;

  public constructor(private readonly config: PipelineDetectionAdapterConfig) {
    this.cache = config.hybridDetection?.cache ?? new ReserveAwareBorrowerCache();
  }

  public async start(): Promise<void> {
    if (this.config.hybridDetection !== undefined) {
      await this.config.hybridDetection.start();
      await this.config.hybridDetection.pollFallback(this.config.chain);
      return;
    }
    await this.refreshCandidates();
  }

  public stop(): void {
    this.config.hybridDetection?.stop();
  }

  public async pollFallback(chain: SupportedChain): Promise<void> {
    if (this.config.hybridDetection !== undefined) {
      await this.config.hybridDetection.pollFallback(chain);
      return;
    }
    await this.refreshCandidates();
  }

  public getCircuitBreakerState(chain: SupportedChain, name: CircuitBreakerName): CircuitBreakerState {
    if (this.config.hybridDetection !== undefined) {
      return this.config.hybridDetection.getCircuitBreakerState(chain, name);
    }
    return { status: "closed", failures: 0 };
  }

  public async collectExtraOpportunities(chain: SupportedChain): Promise<readonly Opportunity[]> {
    if (this.config.enableArbitrage === false) {
      return [];
    }
    return this.config.arbitrageQueue.drain(chain).map((candidate) => fromArbitrageOpportunity(candidate));
  }

  private async refreshCandidates(): Promise<void> {
    if (this.config.monitor === undefined) {
      return;
    }
    const candidates = await this.config.monitor.scanOnce();
    if (candidates.length === 0) {
      return;
    }
    const accounts = [...new Set(candidates.map((candidate) => candidate.account))];
    if (this.config.snapshotProvider === undefined) {
      // Monitor candidates carry the static pair defaultDebtToCoverWei — never price that as real debt.
      for (const account of accounts) {
        this.config.logger?.warn("debt_to_cover_resolve_failed", {
          chain: this.config.chain,
          account,
          error: "no_reserve_resolver",
          action: "skip_candidate",
        });
      }
      return;
    }
    const snapshots = await this.config.snapshotProvider.refreshBorrowers(this.config.chain, accounts);
    for (const snapshot of snapshots) {
      this.cache.upsert(snapshot);
    }
  }
}
