import client from "prom-client";
import express, { type Request, type Response } from "express";
import type { Server } from "http";
import { formatEther } from "viem";
import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import type { ExecutionResult, LiquidationExecutor } from "./executors/liquidationExecutor";
import type { HealthFactorMonitor } from "./monitors/healthFactorMonitor";
import type { LiquidationCandidate } from "./protocols/aaveV3";
import { calculateLiquidationEV } from "./utils/evCalculator";

export type BotLatencyStage = "scan" | "execution" | "poll_cycle";
export type PipelineLatencyStage =
  | "event_to_detection_ms"
  | "detection_to_submit_ms"
  | "submit_to_inclusion_ms"
  | "flashblocks_lead_ms";
export interface LogContext {
  readonly chain?: string;
  readonly opportunityId?: string;
  readonly [key: string]: unknown;
}

export interface LoggerLike {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child?(context: LogContext): LoggerLike;
}

export interface BotDependencies {
  readonly monitor: Pick<HealthFactorMonitor, "scanOnce"> & Partial<Pick<HealthFactorMonitor, "getLastScanStats" | "startReserveDataUpdatedSubscription" | "stopReserveDataUpdatedSubscription">>;
  readonly executor: Pick<LiquidationExecutor, "execute">;
  readonly logger: LoggerLike;
  readonly minProfitWei?: bigint;
  readonly simulationMode?: boolean;
  readonly metrics?: BotMetrics;
  readonly alert?: (event: LiquidationAlertEvent) => Promise<void>;
}

export interface BotCycleSummary {
  readonly scanned: number;
  readonly executed: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface PollingLoopOptions {
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
}

export interface LiquidationAlertEvent {
  readonly mode: "simulated" | "executed";
  readonly candidate: LiquidationCandidate;
  readonly evProfitWei: bigint;
  readonly txHash?: `0x${string}`;
}

export interface BotMetricsSnapshot {
  readonly positionsScanned: number;
  readonly liquidationsAttempted: number;
  readonly liquidationsExecuted: number;
  readonly totalProfitEth: number;
  readonly errorsTotal: number;
  readonly arbitrageOpportunitiesScanned: number;
  readonly arbitrageApproved: number;
  readonly arbitrageExecuted: number;
  readonly netProfitUsd: number;
  readonly publicRpcSubmissions: number;
  readonly privateBundleSubmissions: number;
}

export interface BotMetrics {
  readonly registry: client.Registry;
  recordPositionsScanned(count: number): void;
  recordLiquidationAttempt(): void;
  recordLiquidationExecuted(): void;
  recordProfit(profitWei: bigint): void;
  recordArbitrageOpportunityScanned(count: number): void;
  recordArbitrageApproved(count: number): void;
  recordArbitrageExecuted(count: number): void;
  recordNetProfitUsd(amountUsd: number): void;
  recordBundleSubmission(route: "public_rpc" | "private_bundle"): void;
  recordOracleFreshnessMs(chain: string, token: string, freshnessMs: number, source: string): void;
  recordDustFiltered(count?: number): void;
  recordCooldownBlock(count?: number): void;
  recordSubgraphLag?(blocksBehind: number): void;
  recordError(): void;
  recordLatency(stage: BotLatencyStage, durationSeconds: number, labels?: { readonly chain?: string }): void;
  recordPipelineLatency(
    stage: PipelineLatencyStage,
    durationMs: number,
    labels: {
      readonly chain: string;
      readonly provider: string;
      readonly flashblocks: "enabled" | "disabled";
    },
  ): void;
  setWatchlistSize(chain: string, size: number): void;
  setWatchlistLastUpdateAge(chain: string, ageSeconds: number): void;
  setWatchlistCircuitBreakerOpen(chain: string, open: boolean): void;
  recordWatchlistGapReplay(chain: string): void;
  recordWatchlistSweepLatency(
    durationSeconds: number,
    labels: { readonly chain: string; readonly batchSize: number; readonly addresses: number },
  ): void;
  snapshot(): BotMetricsSnapshot;
}

export class LiquidationBot {
  public constructor(private readonly dependencies: BotDependencies) {}

  public static createMetrics(): BotMetrics {
    return createBotMetrics();
  }

  public async runPollingLoop(options: PollingLoopOptions): Promise<void> {
    await this.dependencies.monitor.startReserveDataUpdatedSubscription?.();
    this.dependencies.logger.info("🚀 Optimism Aave V3 Liquidation Bot Started", {
      simulationMode: this.dependencies.simulationMode ?? true,
    });
    try {
      while (!options.signal.aborted) {
        const startedAt = Date.now();
        await this.runPollingCycle();
        await sleep(remainingDelayMs(startedAt, options.pollIntervalMs), options.signal);
      }
    } finally {
      this.dependencies.monitor.stopReserveDataUpdatedSubscription?.();
      this.dependencies.logger.info("liquidation_bot_shutdown", {
        totalProfitEth: this.dependencies.metrics?.snapshot().totalProfitEth ?? 0,
      });
    }
  }

  private async runPollingCycle(): Promise<void> {
    const startedAt = Date.now();
    try {
      const summary = await this.runOnce();
      this.dependencies.logger.info("poll_cycle_complete", summary);
    } catch (error) {
      this.dependencies.logger.error("poll_cycle_failed", { error });
      this.dependencies.metrics?.recordError();
    } finally {
      this.dependencies.metrics?.recordLatency("poll_cycle", (Date.now() - startedAt) / 1_000);
    }
  }

  public async runOnce(): Promise<BotCycleSummary> {
    const candidates = await this.dependencies.monitor.scanOnce();
    const scanned = this.dependencies.monitor.getLastScanStats?.().scanned ?? candidates.length;
    this.dependencies.metrics?.recordPositionsScanned(scanned);
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    for (const candidate of candidates) {
      if (!this.hasPositiveEv(candidate)) {
        skipped += 1;
        continue;
      }

      const result = await this.executeSafely(candidate);
      this.dependencies.metrics?.recordLiquidationAttempt();
      executed += result.status === "sent" || result.status === "simulated" ? 1 : 0;
      skipped += result.status === "skipped" ? 1 : 0;
      failed += result.status === "failed" ? 1 : 0;
      await this.afterExecution(candidate, result);
    }

    return { scanned, executed, skipped, failed };
  }

  private async executeSafely(candidate: LiquidationCandidate): Promise<ExecutionResult> {
    try {
      return await this.dependencies.executor.execute(candidate);
    } catch (error) {
      this.dependencies.logger.error("candidate_execution_uncaught", { error, candidate });
      this.dependencies.metrics?.recordError();
      return { status: "failed", reason: "uncaught_executor_error", expectedProfitUsd: 0 };
    }
  }

  private async afterExecution(candidate: LiquidationCandidate, result: ExecutionResult): Promise<void> {
    if (result.status === "failed") {
      this.dependencies.metrics?.recordError();
      return;
    }

    if (result.status !== "sent" && result.status !== "simulated") {
      return;
    }

    if (result.status === "sent") {
      this.dependencies.metrics?.recordLiquidationExecuted();
    }

    const evProfitWei = result.expectedProfitWei ?? 0n;
    this.dependencies.metrics?.recordProfit(evProfitWei);
    const alertEvent = {
      mode: result.status === "sent" ? "executed" : "simulated",
      candidate,
      evProfitWei,
      ...(result.status === "sent" ? { txHash: result.txHash } : {}),
    } satisfies LiquidationAlertEvent;
    await this.dependencies.alert?.(alertEvent);
  }

  private hasPositiveEv(candidate: LiquidationCandidate): boolean {
    if (
      this.dependencies.minProfitWei === undefined
      || candidate.collateralReceivedWei === undefined
      || candidate.gasEstimate === undefined
      || candidate.gasPrice === undefined
    ) {
      return true;
    }

    return calculateLiquidationEV(
      candidate.debtToCover,
      candidate.collateralReceivedWei,
      candidate.bonusPercentage ?? candidate.liquidationBonusBps,
      candidate.gasEstimate,
      candidate.gasPrice,
      this.dependencies.minProfitWei,
    ).isProfitable;
  }
}

export function createBotMetrics(): BotMetrics {
  const registry = createMetricsRegistry();
  const snapshot: {
    positionsScanned: number;
    liquidationsAttempted: number;
    liquidationsExecuted: number;
    totalProfitEth: number;
    errorsTotal: number;
    arbitrageOpportunitiesScanned: number;
    arbitrageApproved: number;
    arbitrageExecuted: number;
    netProfitUsd: number;
    publicRpcSubmissions: number;
    privateBundleSubmissions: number;
  } = {
    positionsScanned: 0,
    liquidationsAttempted: 0,
    liquidationsExecuted: 0,
    totalProfitEth: 0,
    errorsTotal: 0,
    arbitrageOpportunitiesScanned: 0,
    arbitrageApproved: 0,
    arbitrageExecuted: 0,
    netProfitUsd: 0,
    publicRpcSubmissions: 0,
    privateBundleSubmissions: 0,
  };
  const positionsScannedTotal = new client.Counter({
    name: "positions_scanned_total",
    help: "Total positions scanned by the liquidation bot",
    registers: [registry],
  });
  const liquidationsAttempted = new client.Counter({
    name: "liquidations_attempted",
    help: "Total liquidation candidates attempted",
    registers: [registry],
  });
  const liquidationsExecuted = new client.Counter({
    name: "liquidations_executed",
    help: "Total live liquidation transactions sent",
    registers: [registry],
  });
  const totalProfitEth = new client.Gauge({
    name: "total_profit_eth",
    help: "Cumulative simulated or executed EV in ETH",
    registers: [registry],
  });
  const errorsTotal = new client.Counter({
    name: "errors_total",
    help: "Total bot errors",
    registers: [registry],
  });
  const arbitrageScanned = new client.Counter({
    name: "arb_opportunities_scanned",
    help: "Total arbitrage opportunities scanned",
    registers: [registry],
  });
  const arbitrageApproved = new client.Counter({
    name: "arb_approved",
    help: "Total arbitrage opportunities approved by profitability",
    registers: [registry],
  });
  const arbitrageExecuted = new client.Counter({
    name: "arb_executed",
    help: "Total arbitrage executions sent",
    registers: [registry],
  });
  const netProfitUsd = new client.Gauge({
    name: "net_profit_usd",
    help: "Cumulative projected net profit in USD",
    registers: [registry],
  });
  const latencySeconds = new client.Histogram({
    name: "bot_latency_seconds",
    help: "Latency of critical bot stages",
    labelNames: ["stage", "chain"],
    registers: [registry],
  });
  const bundleRouteSubmissions = new client.Counter({
    name: "bundle_route_submissions_total",
    help: "Execution submissions by route type",
    labelNames: ["route"],
    registers: [registry],
  });
  const pipelineLatencyMilliseconds = new client.Histogram({
    name: "pipeline_latency_ms",
    help: "Pipeline latency by provider and Flashblocks mode",
    labelNames: ["stage", "chain", "provider", "flashblocks"],
    buckets: [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1_000, 2_000, 5_000],
    registers: [registry],
  });
  const oracleFreshnessMs = new client.Histogram({
    name: "oracle_freshness_ms",
    help: "Age of the underlying oracle price sample in milliseconds",
    labelNames: ["chain", "token", "source"],
    buckets: [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000],
    registers: [registry],
  });
  const dustFilteredTotal = new client.Counter({
    name: "dust_filtered_total",
    help: "Liquidation candidates rejected as dust before enqueue or preview",
    registers: [registry],
  });
  const cooldownBlocksTotal = new client.Counter({
    name: "cooldown_blocks_total",
    help: "Execution attempts blocked by post-dead-letter borrower cooldown",
    registers: [registry],
  });
  const subgraphLagTotal = new client.Counter({
    name: "subgraph_lag_detected_total",
    help: "Borrower watchlist rescans that observed subgraph indexing lag",
    registers: [registry],
  });
  const watchlistSizeTotal = new client.Gauge({
    name: "watchlist_size_total",
    help: "Borrower addresses in the event-driven watchlist",
    labelNames: ["chain"],
    registers: [registry],
  });
  const watchlistLastUpdateAgeSeconds = new client.Gauge({
    name: "watchlist_last_update_age_seconds",
    help: "Seconds since the watchlist last received activity",
    labelNames: ["chain"],
    registers: [registry],
  });
  const watchlistCircuitBreakerOpen = new client.Gauge({
    name: "watchlist_circuit_breaker_open",
    help: "Rescan circuit breaker open (1) or closed (0)",
    labelNames: ["chain"],
    registers: [registry],
  });
  const watchlistGapReplayTotal = new client.Counter({
    name: "watchlist_gap_replay_total",
    help: "Gap replay cycles completed for the event watchlist",
    labelNames: ["chain"],
    registers: [registry],
  });
  const watchlistSweepLatencySeconds = new client.Histogram({
    name: "watchlist_sweep_latency_seconds",
    help: "Multicall HF sweep latency",
    labelNames: ["chain", "batch_size"],
    buckets: [0.05, 0.1, 0.2, 0.4, 0.75, 1, 2, 5],
    registers: [registry],
  });

  return {
    registry,
    recordPositionsScanned(count) {
      snapshot.positionsScanned += count;
      positionsScannedTotal.inc(count);
    },
    recordLiquidationAttempt() {
      snapshot.liquidationsAttempted += 1;
      liquidationsAttempted.inc();
    },
    recordLiquidationExecuted() {
      snapshot.liquidationsExecuted += 1;
      liquidationsExecuted.inc();
    },
    recordProfit(profitWei) {
      const profitEth = Number(formatEther(profitWei));
      snapshot.totalProfitEth += profitEth;
      totalProfitEth.set(snapshot.totalProfitEth);
    },
    recordArbitrageOpportunityScanned(count) {
      snapshot.arbitrageOpportunitiesScanned += count;
      arbitrageScanned.inc(count);
    },
    recordArbitrageApproved(count) {
      snapshot.arbitrageApproved += count;
      arbitrageApproved.inc(count);
    },
    recordArbitrageExecuted(count) {
      snapshot.arbitrageExecuted += count;
      arbitrageExecuted.inc(count);
    },
    recordNetProfitUsd(amountUsd) {
      snapshot.netProfitUsd += amountUsd;
      netProfitUsd.set(snapshot.netProfitUsd);
    },
    recordBundleSubmission(route) {
      if (route === "private_bundle") {
        snapshot.privateBundleSubmissions += 1;
      } else {
        snapshot.publicRpcSubmissions += 1;
      }
      bundleRouteSubmissions.inc({ route });
    },
    recordOracleFreshnessMs(chain, token, freshnessMs, source) {
      oracleFreshnessMs.observe({ chain, token, source }, Math.max(0, freshnessMs));
    },
    recordDustFiltered(count = 1) {
      dustFilteredTotal.inc(count);
    },
    recordCooldownBlock(count = 1) {
      cooldownBlocksTotal.inc(count);
    },
    recordSubgraphLag(blocksBehind) {
      subgraphLagTotal.inc(Math.max(1, blocksBehind));
    },
    recordError() {
      snapshot.errorsTotal += 1;
      errorsTotal.inc();
    },
    recordLatency(stage, durationSeconds, labels = {}) {
      latencySeconds.observe({ stage, chain: labels.chain ?? "unknown" }, durationSeconds);
    },
    recordPipelineLatency(stage, durationMs, labels) {
      pipelineLatencyMilliseconds.observe({
        stage,
        chain: labels.chain,
        provider: labels.provider,
        flashblocks: labels.flashblocks,
      }, Math.max(0, durationMs));
    },
    setWatchlistSize(chain, size) {
      watchlistSizeTotal.set({ chain }, size);
    },
    setWatchlistLastUpdateAge(chain, ageSeconds) {
      watchlistLastUpdateAgeSeconds.set({ chain }, Math.max(0, ageSeconds));
    },
    setWatchlistCircuitBreakerOpen(chain, open) {
      watchlistCircuitBreakerOpen.set({ chain }, open ? 1 : 0);
    },
    recordWatchlistGapReplay(chain) {
      watchlistGapReplayTotal.inc({ chain });
    },
    recordWatchlistSweepLatency(durationSeconds, labels) {
      watchlistSweepLatencySeconds.observe(
        { chain: labels.chain, batch_size: String(labels.batchSize) },
        Math.max(0, durationSeconds),
      );
    },
    snapshot() {
      return { ...snapshot };
    },
  };
}

export function startMetricsServer(
  metrics: BotMetrics,
  logger: LoggerLike,
  port = 9090,
): Server {
  const app = express();
  app.get("/healthz", (_request: Request, response: Response) => {
    response.json({ status: "ok" });
  });
  app.get("/metrics", async (_request: Request, response: Response) => {
    response.setHeader("content-type", metrics.registry.contentType);
    response.send(await metrics.registry.metrics());
  });

  const server = app.listen(port, () => {
    logger.info("metrics_server_started", { port });
  });

  return server;
}

function remainingDelayMs(startedAt: number, pollIntervalMs: number): number {
  return Math.max(0, pollIntervalMs - (Date.now() - startedAt));
}

function sleep(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs <= 0 || signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, durationMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export function createLogger(
  level = "info",
  context: LogContext = {},
  destination?: DestinationStream,
): LoggerLike {
  const logger = destination === undefined
    ? pino(createPinoOptions(level))
    : pino(createPinoOptions(level), destination);
  const contextualLogger = Object.keys(context).length === 0 ? logger : logger.child(context);
  return new PinoLoggerAdapter(contextualLogger);
}

export function createMetricsRegistry(): client.Registry {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  return registry;
}

class PinoLoggerAdapter implements LoggerLike {
  public constructor(private readonly logger: PinoLogger) {}

  public info(message: string, meta?: unknown): void {
    this.logger.info(toLogObject(meta), message);
  }

  public warn(message: string, meta?: unknown): void {
    this.logger.warn(toLogObject(meta), message);
  }

  public error(message: string, meta?: unknown): void {
    this.logger.error(toLogObject(meta), message);
  }

  public child(context: LogContext): LoggerLike {
    return new PinoLoggerAdapter(this.logger.child(context));
  }
}

function createPinoOptions(level: string): pino.LoggerOptions {
  return {
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      error: pino.stdSerializers.err,
      err: pino.stdSerializers.err,
    },
  };
}

function toLogObject(meta: unknown): Record<string, unknown> {
  if (meta === undefined) {
    return {};
  }
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }

  return { value: meta };
}
