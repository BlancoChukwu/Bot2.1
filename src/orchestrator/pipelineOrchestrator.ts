import type { Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry, CircuitBreakerName, CircuitBreakerState } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { SafeExecutionRequest, SafeExecutionResult } from "../executors/safeTransactionExecutor";
import { ReserveAwareBorrowerCache, createReserveAwareCandidates } from "../monitors/reserveAwareBorrowerCache";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import type { RouteSelectionInput } from "../profitability/flashLoanProviderRouter";
import type { Opportunity } from "../types/opportunity";
import { fromLiquidationCandidate } from "../types/opportunity";
import type { LiquidationCandidateGate } from "./liquidationCandidateGate";
import type { StalenessGuard } from "../monitors/stalenessGuard";
import { getCycleDiagnosticsCollector } from "../observability/cycleDiagnostics";
import type { SimFailureCircuitBreaker } from "../executors/simFailureCircuitBreaker";

export interface PipelineLoopOptions {
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
}

export interface PipelineDetection {
  readonly cache: ReserveAwareBorrowerCache;
  start(): Promise<void>;
  stop(): void;
  pollFallback(chain: SupportedChain): Promise<void>;
  getCircuitBreakerState(chain: SupportedChain, name: CircuitBreakerName): CircuitBreakerState;
  collectExtraOpportunities?(chain: SupportedChain): Promise<readonly Opportunity[]>;
}

export interface SafeExecutionClient {
  execute(request: SafeExecutionRequest): Promise<SafeExecutionResult>;
}

export interface PipelineOpportunityRanker {
  rank(chain: SupportedChain, plans: readonly PipelineExecutionPlan[]): Promise<readonly PipelineExecutionPlan[]>;
}

export interface PipelineExecutionPlan {
  readonly chain: SupportedChain;
  readonly opportunity: Opportunity;
  readonly candidate?: LiquidationCandidate;
  readonly request: SafeExecutionRequest;
}

export type PipelineObservedOutcome = "won" | "missed" | "reverted" | "lost_to_competitor";

export interface PipelineOutcomeObserver {
  recordOutcome(outcome: {
    readonly chain: SupportedChain;
    readonly opportunityId: string;
    readonly features: readonly string[];
    readonly expectedProfitBps: number;
    readonly outcome: PipelineObservedOutcome;
  }): void | Promise<void>;
}

export interface PipelineOrchestratorConfig {
  readonly registry: ChainRegistry;
  readonly detection: PipelineDetection;
  readonly executor: SafeExecutionClient;
  readonly deadLetters: PipelineDeadLetterQueue;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly maxCacheAgeMs?: number;
  readonly opportunityRanker?: PipelineOpportunityRanker;
  readonly outcomeObserver?: PipelineOutcomeObserver;
  readonly cycleObserver?: (summary: PipelineRunSummary) => void | Promise<void>;
  readonly sequencerGuard?: {
    isUp(chain: SupportedChain): Promise<boolean>;
  };
  buildExecutionRequest(candidate: LiquidationCandidate): SafeExecutionRequest | undefined | Promise<SafeExecutionRequest | undefined>;
  buildExecutionRequestForOpportunity?(
    opportunity: Opportunity,
  ): SafeExecutionRequest | undefined | Promise<SafeExecutionRequest | undefined>;
  readonly liquidationGate?: LiquidationCandidateGate;
  readonly watchlistStaleness?: StalenessGuard;
  /** Event-watchlist periodic HF sweep (e.g. when block WS subscription is unavailable). */
  readonly watchlistSweep?: (chain: SupportedChain) => Promise<void>;
  readonly simFailureCircuit?: SimFailureCircuitBreaker;
  readonly blocksPerCycle?: () => number;
  readonly watchlistStats?: () => { readonly watchlistSize: number; readonly borrowersDiscovered: number };
  /** Rotating HF multicall sample — feeds pipeline_cycle_diagnostics each cycle. */
  readonly watchlistDiagnosticSample?: (
    chain: SupportedChain,
  ) => Promise<readonly {
    readonly account: Address;
    readonly healthFactor: bigint;
    readonly debtUsd?: number;
  }[]>;
  /** Consecutive critical staleness cycles before paging (default 3). */
  readonly watchlistCriticalAlertCycles?: number;
  readonly onWatchlistStaleCritical?: (input: {
    readonly chain: SupportedChain;
    readonly ageMs: number;
    readonly consecutive: number;
  }) => void | Promise<void>;
  /** When true, skip execution early-return despite critical watchlist staleness. */
  readonly eventPurityStalenessBypass?: () => boolean;
  readonly emitWatchlistHeartbeat?: (reason: string) => void;
}

export interface PipelineRunSummary {
  readonly scanned: number;
  readonly attempted: number;
  readonly sent: number;
  readonly simulated: number;
  readonly rejected: number;
  readonly failed: number;
  readonly deadLetters: number;
  readonly revenue_this_cycle: number;
  readonly evaluations: number;
  readonly sims: number;
  readonly opps_per_block: number;
}

export interface PipelineDeadLetter {
  readonly chain: SupportedChain;
  readonly opportunityId: string;
  readonly account: Address;
  readonly reason: string;
  readonly createdAtMs: number;
}

export class PipelineDeadLetterQueue {
  private readonly entries: PipelineDeadLetter[] = [];
  private dropped = 0;

  public constructor(private readonly options: { readonly maxEntries?: number } = {}) {
    if (options.maxEntries !== undefined && options.maxEntries < 1) {
      throw new Error("maxEntries must be positive");
    }
  }

  public enqueue(entry: Omit<PipelineDeadLetter, "createdAtMs">): void {
    const maxEntries = this.options.maxEntries ?? 1_000;
    while (this.entries.length >= maxEntries) {
      this.entries.shift();
      this.dropped += 1;
    }
    this.entries.push({ ...entry, createdAtMs: Date.now() });
  }

  public list(): PipelineDeadLetter[] {
    return [...this.entries];
  }

  public droppedCount(): number {
    return this.dropped;
  }
}

export class PipelineOrchestrator {
  private readonly maxCacheAgeMs: number;
  private consecutiveWatchlistCritical = 0;

  public constructor(private readonly config: PipelineOrchestratorConfig) {
    this.maxCacheAgeMs = config.maxCacheAgeMs ?? 30_000;
  }

  public async start(): Promise<void> {
    await this.config.detection.start();
    this.config.logger.info("pipeline_orchestrator_started", {
      chains: this.config.registry.listChains(),
    });
  }

  public stop(): void {
    this.config.detection.stop();
    this.config.logger.info("pipeline_orchestrator_stopped");
  }

  public async runLoop(options: PipelineLoopOptions): Promise<void> {
    await this.start();
    try {
      while (!options.signal.aborted) {
        const startedAt = Date.now();
        try {
          await this.runOnce();
        } catch (error) {
          this.config.metrics.recordError();
          this.config.logger.error("pipeline_cycle_failed", { error });
        }
        await sleep(remainingDelayMs(startedAt, options.pollIntervalMs), options.signal);
      }
    } finally {
      this.stop();
    }
  }

  public async runOnce(): Promise<PipelineRunSummary> {
    const startedAt = Date.now();
    const summary = mutableSummary();
    try {
      for (const chain of this.config.registry.listChains()) {
        await this.runChain(chain, summary);
        if (this.config.watchlistDiagnosticSample !== undefined && this.config.liquidationGate !== undefined) {
          const hfReads = await this.config.watchlistDiagnosticSample(chain);
          if (hfReads.length > 0) {
            this.config.liquidationGate.recordHealthFactorDiagnostics(chain, hfReads, "pipeline_cycle_sample");
          }
        }
      }
      const diagnostics = getCycleDiagnosticsCollector();
      const blocksDelta = Math.max(1, this.config.blocksPerCycle?.() ?? 1);
      const frozen = freezeSummary(summary, diagnostics.snapshot(summary.sent, blocksDelta));
      const watchlistStats = this.config.watchlistStats?.();
      if (watchlistStats !== undefined) {
        this.config.logger.info("watchlist_cycle_stats", {
          watchlistSize: watchlistStats.watchlistSize,
          borrowersDiscovered: watchlistStats.borrowersDiscovered,
        });
      }
      diagnostics.emit(this.config.logger, summary.sent, blocksDelta);
      diagnostics.reset();
      this.config.logger.info("pipeline_cycle_complete", frozen);
      await this.config.cycleObserver?.(frozen);
      return frozen;
    } finally {
      this.config.metrics.recordLatency("poll_cycle", (Date.now() - startedAt) / 1_000);
    }
  }

  private async runChain(chain: SupportedChain, summary: MutablePipelineRunSummary): Promise<void> {
    if (this.config.watchlistSweep !== undefined) {
      try {
        await this.config.watchlistSweep(chain);
      } catch (error) {
        this.config.metrics.recordError();
        this.config.logger.error("watchlist_sweep_failed", { chain, error });
      }
    }

    this.config.emitWatchlistHeartbeat?.("pipeline_cycle");

    const staleness = this.config.watchlistStaleness?.check();
    if (staleness === "critical") {
      this.consecutiveWatchlistCritical += 1;
      const ageMs = this.config.watchlistStaleness?.ageMs() ?? 0;
      this.config.logger.error("watchlist_stale_critical", {
        chain,
        ageMs,
        consecutive: this.consecutiveWatchlistCritical,
      });
      this.config.metrics.recordWatchlistStaleEvaluation(chain, "critical");
      this.config.metrics.recordError();

      const alertThreshold = this.config.watchlistCriticalAlertCycles ?? 3;
      if (this.consecutiveWatchlistCritical >= alertThreshold) {
        void this.config.onWatchlistStaleCritical?.({
          chain,
          ageMs,
          consecutive: this.consecutiveWatchlistCritical,
        });
      }

      if (this.config.eventPurityStalenessBypass?.() === true) {
        this.config.logger.warn("watchlist_stale_bypassed_event_purity_healthy", {
          chain,
          ageMs,
          consecutive: this.consecutiveWatchlistCritical,
        });
      } else {
        return;
      }
    } else {
      this.consecutiveWatchlistCritical = 0;
      if (staleness === "stale") {
        this.config.logger.warn("watchlist_stale", {
          chain,
          ageMs: this.config.watchlistStaleness?.ageMs(),
        });
        this.config.metrics.recordWatchlistStaleEvaluation(chain, "stale");
      }
    }

    if (this.config.sequencerGuard !== undefined) {
      const sequencerUp = await this.config.sequencerGuard.isUp(chain);
      if (!sequencerUp) {
        this.config.logger.warn("pipeline_execution_paused_sequencer_down", { chain });
        return;
      }
    }
    if (this.config.registry.get(chain).circuitBreakers.execution.status === "open") {
      this.config.logger.warn("pipeline_execution_circuit_open", { chain });
      return;
    }

    const degraded = this.isCircuitOpen(chain, "rpc") || this.isCircuitOpen(chain, "subgraph");
    if (degraded) {
      const refreshed = await this.runDegradedPolling(chain);
      if (!refreshed || !this.hasFreshCache(chain)) {
        this.config.logger.warn("pipeline_execution_skipped_stale_cache", { chain });
        return;
      }
    }

    const rawCandidates = degraded
      ? this.createFreshCandidates(chain)
      : createReserveAwareCandidates(this.config.detection.cache, chain);
    const baseCandidates = this.config.liquidationGate === undefined
      ? rawCandidates
      : await this.config.liquidationGate.filterCandidates(chain, rawCandidates, "pipeline_enqueue");
    const baseOpportunities = baseCandidates.map((candidate) => fromLiquidationCandidate(candidate));
    const extraOpportunities = await this.config.detection.collectExtraOpportunities?.(chain) ?? [];
    const plans = await this.buildExecutionPlans(chain, [...baseOpportunities, ...extraOpportunities], summary);
    const rankedPlans = await this.rankPlans(chain, plans);
    summary.scanned += rankedPlans.length;
    this.config.metrics.recordPositionsScanned(rankedPlans.length);
    for (const plan of rankedPlans) {
      await this.executePlan(plan, summary);
    }
  }

  private async runDegradedPolling(chain: SupportedChain): Promise<boolean> {
    this.config.logger.warn("pipeline_degraded_polling_active", { chain });
    try {
      await this.config.detection.pollFallback(chain);
      return true;
    } catch (error) {
      this.config.metrics.recordError();
      this.config.logger.error("pipeline_degraded_polling_failed", { chain, error });
      return false;
    }
  }

  private async buildExecutionPlans(
    chain: SupportedChain,
    opportunities: readonly Opportunity[],
    summary: MutablePipelineRunSummary,
  ): Promise<PipelineExecutionPlan[]> {
    const plans: PipelineExecutionPlan[] = [];
    for (const opportunity of opportunities) {
      if (
        opportunity.kind === "liquidation"
        && this.config.liquidationGate !== undefined
        && this.config.liquidationGate.isBorrowerBlocked(chain, opportunity.candidate.account)
      ) {
        continue;
      }
      try {
        const request = await this.buildExecutionRequest(opportunity);
        if (request !== undefined) {
          plans.push({
            chain,
            opportunity,
            ...(opportunity.kind === "liquidation" ? { candidate: opportunity.candidate } : {}),
            request,
          });
        }
      } catch (error) {
        summary.failed += 1;
        this.config.metrics.recordError();
        this.deadLetterOpportunity(chain, opportunity, "request_builder_exception");
        this.config.logger.error("pipeline_request_builder_failed", {
          chain,
          opportunityId: opportunity.kind === "liquidation"
            ? `${chain}:${opportunity.candidate.account}:${opportunity.candidate.debtAsset}`
            : opportunity.candidate.opportunityId,
          error,
        });
      }
    }

    return plans;
  }

  private async executePlan(
    plan: PipelineExecutionPlan,
    summary: MutablePipelineRunSummary,
  ): Promise<void> {
    const { request } = plan;
    if (
      plan.opportunity.kind === "liquidation"
      && this.config.liquidationGate !== undefined
      && this.config.liquidationGate.isBorrowerBlocked(plan.chain, plan.opportunity.candidate.account)
    ) {
      this.config.logger.info("pipeline_execution_skipped_borrower_cooldown", {
        chain: plan.chain,
        account: plan.opportunity.candidate.account,
        opportunityId: request.opportunityId,
      });
      return;
    }
    summary.attempted += 1;
    this.config.metrics.recordLiquidationAttempt();
    this.config.logger.info("pipeline_execution_started", {
      chain: request.chain,
      opportunityId: request.opportunityId,
      account: request.account,
    });

    try {
      const result = await this.config.executor.execute(request);
      this.recordExecutionResult(plan, request, result, summary);
      await this.recordLearningOutcome(plan, toLearningOutcome(result));
    } catch (error) {
      summary.failed += 1;
      this.config.metrics.recordError();
      this.deadLetter(request, "executor_exception");
      await this.recordLearningOutcome(plan, "missed");
      this.config.logger.error("pipeline_execution_exception", {
        chain: request.chain,
        opportunityId: request.opportunityId,
        error,
      });
    }
  }

  private recordExecutionResult(
    plan: PipelineExecutionPlan,
    request: SafeExecutionRequest,
    result: SafeExecutionResult,
    summary: MutablePipelineRunSummary,
  ): void {
    if (result.status === "sent") {
      summary.sent += 1;
      if (plan.opportunity.kind === "arbitrage") {
        this.config.metrics.recordArbitrageExecuted(1);
      } else {
        this.config.metrics.recordLiquidationExecuted();
      }
      this.config.logger.info("pipeline_execution_sent", {
        chain: request.chain,
        opportunityId: request.opportunityId,
        txHash: result.txHash,
      });
      return;
    }
    if (result.status === "simulated") {
      summary.simulated += 1;
      getCycleDiagnosticsCollector().recordSim();
      this.config.simFailureCircuit?.recordSuccess();
      this.config.logger.info("pipeline_execution_simulated", {
        chain: request.chain,
        opportunityId: request.opportunityId,
      });
      return;
    }

    if (result.status === "rejected") {
      summary.rejected += 1;
      this.config.simFailureCircuit?.recordSimFailure(result.reason);
      if (result.reason === "dust_filtered" || result.reason === "borrower_cooldown") {
        this.config.logger.info("pipeline_execution_skipped_guard", {
          chain: request.chain,
          opportunityId: request.opportunityId,
          reason: result.reason,
        });
        return;
      }
    } else {
      summary.failed += 1;
      this.config.metrics.recordError();
      this.config.simFailureCircuit?.recordSimFailure(result.reason);
    }

    this.deadLetter(request, result.reason);
    this.config.logger.warn("pipeline_execution_dead_lettered", {
      chain: request.chain,
      opportunityId: request.opportunityId,
      reason: result.reason,
    });
  }

  private deadLetter(request: SafeExecutionRequest, reason: string): void {
    if (reason === "dust_filtered" || reason === "borrower_cooldown") {
      return;
    }
    this.config.liquidationGate?.recordDeadLetter(request.chain, request.account, reason);
    this.config.deadLetters.enqueue({
      chain: request.chain,
      opportunityId: request.opportunityId,
      account: request.account,
      reason,
    });
  }

  private deadLetterCandidate(
    chain: SupportedChain,
    candidate: LiquidationCandidate,
    reason: string,
  ): void {
    if (reason !== "dust_filtered") {
      this.config.liquidationGate?.recordDeadLetter(chain, candidate.account, reason);
    }
    this.config.deadLetters.enqueue({
      chain,
      opportunityId: `${chain}:${candidate.account}:${candidate.debtAsset}`,
      account: candidate.account,
      reason,
    });
  }

  private deadLetterOpportunity(
    chain: SupportedChain,
    opportunity: Opportunity,
    reason: string,
  ): void {
    if (opportunity.kind === "liquidation") {
      this.deadLetterCandidate(chain, opportunity.candidate, reason);
      return;
    }
    this.config.deadLetters.enqueue({
      chain,
      opportunityId: opportunity.candidate.opportunityId,
      // SafeExecutionRequest requires an account. For arbitrage we use tokenIn as a deterministic identifier.
      account: opportunity.candidate.tokenIn,
      reason,
    });
  }

  private isCircuitOpen(chain: SupportedChain, breaker: CircuitBreakerName): boolean {
    return this.config.detection.getCircuitBreakerState(chain, breaker).status === "open";
  }

  private hasFreshCache(chain: SupportedChain): boolean {
    const minUpdatedAtMs = Date.now() - this.maxCacheAgeMs;
    return this.config.detection.cache
      .listSnapshots(chain)
      .some((snapshot) => snapshot.updatedAtMs >= minUpdatedAtMs);
  }

  private createFreshCandidates(chain: SupportedChain): LiquidationCandidate[] {
    const minUpdatedAtMs = Date.now() - this.maxCacheAgeMs;
    const freshCache = new ReserveAwareBorrowerCache();
    for (const snapshot of this.config.detection.cache.listSnapshots(chain)) {
      if (snapshot.updatedAtMs >= minUpdatedAtMs) {
        freshCache.upsert(snapshot);
      }
    }

    return createReserveAwareCandidates(freshCache, chain);
  }

  private async rankPlans(
    chain: SupportedChain,
    plans: readonly PipelineExecutionPlan[],
  ): Promise<readonly PipelineExecutionPlan[]> {
    if (this.config.opportunityRanker === undefined) {
      return plans;
    }

    try {
      const startedAt = Date.now();
      const ranked = await this.config.opportunityRanker.rank(chain, plans);
      this.config.metrics.recordLatency("scan", (Date.now() - startedAt) / 1_000, { chain });
      return ranked;
    } catch (error) {
      this.config.metrics.recordError();
      this.config.logger.error("pipeline_opportunity_ranker_failed", { chain, error });
      return plans;
    }
  }

  private async recordLearningOutcome(
    plan: PipelineExecutionPlan,
    outcome: PipelineObservedOutcome,
  ): Promise<void> {
    if (this.config.outcomeObserver === undefined) {
      return;
    }

    try {
      await this.config.outcomeObserver.recordOutcome({
        chain: plan.chain,
        opportunityId: plan.request.opportunityId,
        features: opportunityFeatures(plan.opportunity),
        expectedProfitBps: expectedProfitBps(plan.request.routeInput),
        outcome,
      });
    } catch (error) {
      this.config.metrics.recordError();
      this.config.logger.error("pipeline_outcome_observer_failed", {
        chain: plan.chain,
        opportunityId: plan.request.opportunityId,
        error,
      });
    }
  }

  private async buildExecutionRequest(opportunity: Opportunity): Promise<SafeExecutionRequest | undefined> {
    if (this.config.buildExecutionRequestForOpportunity !== undefined) {
      return this.config.buildExecutionRequestForOpportunity(opportunity);
    }
    if (opportunity.kind === "liquidation") {
      return this.config.buildExecutionRequest(opportunity.candidate);
    }
    return undefined;
  }
}

function opportunityFeatures(opportunity: Opportunity): string[] {
  if (opportunity.kind === "liquidation") {
    return [
      "type:liquidation",
      `collateral:${opportunity.candidate.collateralAsset.toLowerCase()}`,
      `debt:${opportunity.candidate.debtAsset.toLowerCase()}`,
    ];
  }
  return [
    "type:arbitrage",
    `buyDex:${opportunity.candidate.buyDex.name}`,
    `sellDex:${opportunity.candidate.sellDex.name}`,
    `pair:${opportunity.candidate.tokenIn.toLowerCase()}:${opportunity.candidate.tokenOut.toLowerCase()}`,
  ];
}

function toLearningOutcome(result: SafeExecutionResult): PipelineObservedOutcome {
  if (result.status === "sent") {
    return "won";
  }
  if (result.status === "failed" && result.reason === "receipt_reverted") {
    return "reverted";
  }

  return "missed";
}

function expectedProfitBps(input: RouteSelectionInput): number {
  const cost =
    input.debt.raw
    + input.gas.raw
    + input.swapCost.raw
    + input.slippageBuffer.raw
    + input.safetyBuffer.raw;
  if (input.revenue.raw <= cost || input.capitalAtRisk.raw === 0n) {
    return 0;
  }

  return Number(((input.revenue.raw - cost) * 10_000n) / input.capitalAtRisk.raw);
}

interface MutablePipelineRunSummary {
  scanned: number;
  attempted: number;
  sent: number;
  simulated: number;
  rejected: number;
  failed: number;
  deadLetters: number;
}

function mutableSummary(): MutablePipelineRunSummary {
  return { scanned: 0, attempted: 0, sent: 0, simulated: 0, rejected: 0, failed: 0, deadLetters: 0 };
}

function freezeSummary(
  summary: MutablePipelineRunSummary,
  diagnostics: {
    revenue_this_cycle: number;
    evaluations: number;
    sims: number;
    opps_per_block: number;
  },
): PipelineRunSummary {
  return {
    ...summary,
    deadLetters: summary.rejected + summary.failed,
    revenue_this_cycle: diagnostics.revenue_this_cycle,
    evaluations: diagnostics.evaluations,
    sims: diagnostics.sims,
    opps_per_block: diagnostics.opps_per_block,
  };
}

function remainingDelayMs(startedAt: number, pollIntervalMs: number): number {
  return Math.max(0, pollIntervalMs - (Date.now() - startedAt));
}

async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

