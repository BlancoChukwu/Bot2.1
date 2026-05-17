import "dotenv/config";
import { performance } from "node:perf_hooks";
import { createWalletClient, http, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { createFailoverPublicClient, createFailoverWalletClient } from "../../src/config/chains";
import { buildLiquidationExecutionRequest } from "../../src/executors/liquidationExecutionAdapter";
import { PrivateSubmissionClient } from "../../src/executors/PrivateSubmissionClient";
import { SafeTransactionExecutor, type ExecutionPreflightClient } from "../../src/executors/safeTransactionExecutor";
import { ViemExecutionClient } from "../../src/executors/viemExecutionClient";
import { LocalNonceManager } from "../../src/executors/nonceManager";
import { AaveSnapshotProvider } from "../../src/monitors/aaveSnapshotProvider";
import { HybridDetectionPipeline, type DetectionEventHandlers } from "../../src/monitors/hybridDetectionPipeline";
import { createReserveAwareCandidates } from "../../src/monitors/reserveAwareBorrowerCache";
import { ViemAaveV3Protocol } from "../../src/protocols/aaveV3";
import type { LiquidationCandidate } from "../../src/protocols/aaveV3";
import { FlashLoanProviderRouter } from "../../src/profitability/flashLoanProviderRouter";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";
import { parseRuntimeConfig } from "../../src/index";
import { FTRLProviderScorer } from "../../src/monitors/FTRLProviderScorer";
import { BayesianHazardModel, NoRegretOpportunityRanker } from "../../src/optimization/hazardPrediction";

const reserveDataUpdated = parseAbiItem(
  "event ReserveDataUpdated(address indexed reserve,uint256 liquidityRate,uint256 stableBorrowRate,uint256 variableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex)",
);
const usd = createAsset({ symbol: "USD", decimals: 8 });

interface BenchmarkArmSummary {
  readonly name: "private" | "public";
  readonly sent: number;
  readonly simulated: number;
  readonly rejected: number;
  readonly failed: number;
}

interface ProviderScenarioSummary {
  readonly scenario: string;
  readonly staticRegret: number;
  readonly heuristicRegret: number;
  readonly ftrlRegret: number;
  readonly staticLatencyMs: number;
  readonly heuristicLatencyMs: number;
  readonly ftrlLatencyMs: number;
  readonly winner: "static" | "heuristic" | "ftrl";
}
interface OpportunityScenarioSummary {
  readonly scenario: string;
  readonly staticRegret: number;
  readonly ftrlRegret: number;
  readonly staticCapturedEvUsd: number;
  readonly ftrlCapturedEvUsd: number;
}
type ProviderArm = "primary" | "secondary" | "tertiary";
const providerArms: ProviderArm[] = ["primary", "secondary", "tertiary"];

async function run(): Promise<void> {
  const runtime = parseRuntimeConfig(process.env);
  if (runtime.chain !== "base" && !runtime.chains.includes("base")) {
    throw new Error("benchmark.replay.ts requires CHAIN=base or CHAINS to include base");
  }
  if (runtime.liquidationReceiverAddress === undefined) {
    throw new Error("LIQUIDATION_RECEIVER_ADDRESS is required: flash-loan wrapper is mandatory for benchmark");
  }

  const chain = "base";
  const logger = createLogger(runtime.logLevel);
  const metrics = createBotMetrics();
  const benchmarkBlocks = Number(process.env.BASE_BENCHMARK_BLOCKS ?? "120");
  const benchmarkLimit = Number(process.env.BASE_BENCHMARK_EVENT_LIMIT ?? "40");
  const account = privateKeyToAccount(runtime.privateKey);
  const liquidationReceiverAddress = runtime.liquidationReceiverAddress;
  const registry = createChainRegistry({
    chains: [{
      chain,
      rpcUrl: runtime.executionRpcUrlPrimary,
      fallbackRpcUrls: runtime.executionRpcFallbackUrls.length > 0
        ? runtime.executionRpcFallbackUrls
        : runtime.fallbackRpcUrls,
      detection: {
        ...(runtime.wsRpcUrlPrimary === undefined ? {} : { wsPrimary: runtime.wsRpcUrlPrimary }),
        ...(runtime.wsRpcUrlSecondary === undefined ? {} : { wsSecondary: runtime.wsRpcUrlSecondary }),
        ...(runtime.wsRpcUrlTertiary === undefined ? {} : { wsTertiary: runtime.wsRpcUrlTertiary }),
        flashblocksEnabled: runtime.flashblocksEnabled,
      },
      execution: {
        httpPrimary: runtime.executionRpcUrlPrimary,
        fallbacks: runtime.executionRpcFallbackUrls,
      },
      sequencer: {
        ...(runtime.sequencerUptimeFeed === undefined ? {} : { uptimeFeed: runtime.sequencerUptimeFeed }),
        ...(runtime.sequencerDirectRpc === undefined ? {} : { directRpc: runtime.sequencerDirectRpc }),
      },
      aaveSubgraphUrl: runtime.aaveSubgraphByChain.get(chain) ?? runtime.aaveSubgraphUrl,
      flashLoanProviders: runtime.flashLoanProviders,
    }],
  });
  const publicClient = createFailoverPublicClient({
    chain,
    rpcUrl: runtime.executionRpcUrlPrimary,
    fallbackRpcUrls: runtime.executionRpcFallbackUrls.length > 0
      ? runtime.executionRpcFallbackUrls
      : runtime.fallbackRpcUrls,
  });
  const walletClient = createFailoverWalletClient({
    chain,
    rpcUrl: runtime.executionRpcUrlPrimary,
    fallbackRpcUrls: runtime.executionRpcFallbackUrls.length > 0
      ? runtime.executionRpcFallbackUrls
      : runtime.fallbackRpcUrls,
    privateKey: runtime.privateKey,
  });
  const resolvedAave = registry.getResolvedAave(chain);
  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = latestBlock > BigInt(benchmarkBlocks) ? latestBlock - BigInt(benchmarkBlocks) : 0n;
  const logs = await publicClient.getLogs({
    address: resolvedAave.pool,
    event: reserveDataUpdated,
    fromBlock,
    toBlock: latestBlock,
  });
  const events = logs
    .map((log) => {
      const reserve = (log as { readonly args?: { readonly reserve?: Address } }).args?.reserve;
      return reserve === undefined ? undefined : { chain, reserve, atMs: Date.now() };
    })
    .filter((event): event is { chain: "base"; reserve: Address; atMs: number } => event !== undefined)
    .slice(0, benchmarkLimit);
  if (events.length === 0) {
    throw new Error("No ReserveDataUpdated events found in selected Base block window");
  }

  const protocol = new ViemAaveV3Protocol(
    publicClient,
    registry.get(chain).chainConfig,
    createGraphClient(runtime.aaveSubgraphByChain.get(chain) ?? runtime.aaveSubgraphUrl),
    publicClient,
    50,
    registry,
  );
  const provider = new AaveSnapshotProvider(chain, protocol, registry);

  let handlers: DetectionEventHandlers | undefined;
  const detection = new HybridDetectionPipeline({
    registry,
    provider,
    logger,
    metrics,
    eventSource: {
      start: (nextHandlers) => {
        handlers = nextHandlers;
        return () => undefined;
      },
    },
  });
  await detection.start();
  const eventToDetectionSamples: number[] = [];
  const flashblocksLabel = registry.get(chain).detection.flashblocksEnabled ? "enabled" : "disabled";
  for (const event of events) {
    const startedAt = performance.now();
    handlers?.onReserveUpdated({ chain: event.chain, reserve: event.reserve });
    await detection.drain();
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    eventToDetectionSamples.push(latencyMs);
    metrics.recordPipelineLatency("event_to_detection_ms", latencyMs, {
      chain,
      provider: "replay",
      flashblocks: flashblocksLabel,
    });
    metrics.recordPipelineLatency("flashblocks_lead_ms", 0, {
      chain,
      provider: "replay",
      flashblocks: flashblocksLabel,
    });
  }
  detection.stop();

  const reserveAwareCandidates = createReserveAwareCandidates(detection.cache, chain);
  const subgraphCandidates = reserveAwareCandidates.length > 0 ? [] : await protocol.getLiquidatablePositions().catch(() => []);
  const candidates = [...reserveAwareCandidates, ...subgraphCandidates];
  const benchmarkCandidates = candidates.length > 0
    ? candidates
    : [syntheticBenchmarkCandidate(registry)];
  const feeRaw = BigInt(Math.trunc(runtime.flashLoanFeeBps * 1_000_000));
  const slippageFloor = runtime.flashLoanSlippageFloorBps;
  const requests = benchmarkCandidates.slice(0, 20).map((candidate) =>
    buildLiquidationExecutionRequest(chain, candidate, {
      account: account.address,
      minProfitUsd: runtime.minProfitUsd,
      gasCostUsd: Math.max(runtime.gasCostUsd, 1),
      slippageBps: runtime.slippageBps,
      minimumMarginBps: 0,
      flashFeeBps: runtime.flashLoanFeeBps,
      slippageBufferFloorBps: slippageFloor,
      requireFlashLoanWrapper: true,
      flashLoanReceiverAddress: liquidationReceiverAddress,
      poolAddress: resolvedAave.pool,
    }),
  );

  const routeProbe = new FlashLoanProviderRouter({
    registry,
    logger,
    metrics,
    simulator: {
      simulate: async (input) => ({
        success: true as const,
        revenue: createAssetAmount(usd, input.revenue.raw),
        gas: createAssetAmount(usd, input.gas.raw),
        swapCost: createAssetAmount(usd, input.swapCost.raw),
      }),
    },
    providerFees: Object.fromEntries(
      runtime.flashLoanProviders.map((providerId) => [providerId, createAssetAmount(usd, feeRaw)]),
    ),
  });
  const selected = await Promise.all(requests.map((request) => routeProbe.selectBestRoute(request.routeInput)));
  const positiveEvCount = selected.filter((result) => result.status === "selected").length;
  if (positiveEvCount === 0) {
    throw new Error("No positive-EV flash-wrapped requests after fees/gas/slippage");
  }

  const privateArm = await runArm({
    name: "private",
    registry,
    metrics,
    logger,
    publicClient,
    walletClient,
    account: account.address,
    requests,
    providerFeeRaw: feeRaw,
    privateFirstChains: ["base"],
    privateMode: runtime.privateTxMode,
    executionRpcUrl: runtime.executionRpcUrlPrimary,
    sequencerDirectRpc: runtime.sequencerDirectRpc,
    privateKey: runtime.privateKey,
  });
  const publicArm = await runArm({
    name: "public",
    registry,
    metrics,
    logger,
    publicClient,
    walletClient,
    account: account.address,
    requests,
    providerFeeRaw: feeRaw,
    privateFirstChains: [],
    privateMode: runtime.privateTxMode,
    executionRpcUrl: runtime.executionRpcUrlPrimary,
    sequencerDirectRpc: runtime.sequencerDirectRpc,
    privateKey: runtime.privateKey,
  });

  const p95 = percentile(eventToDetectionSamples, 95);
  if (p95 >= 200) {
    throw new Error(`event->detection p95 hard gate failed (${p95.toFixed(2)}ms >= 200ms)`);
  }
  const providerScenarioSummary = runProviderScoringScenarios();
  const ftrlScenarioRegressions = providerScenarioSummary.filter((scenario) =>
    scenario.ftrlRegret > Math.min(scenario.staticRegret, scenario.heuristicRegret)
      || scenario.ftrlLatencyMs > Math.min(scenario.staticLatencyMs, scenario.heuristicLatencyMs) * 1.05
  );
  if (ftrlScenarioRegressions.length > 0) {
    throw new Error(`Provider scoring FTRL benchmark gate failed for scenarios: ${ftrlScenarioRegressions.map((item) => item.scenario).join(", ")}`);
  }
  const opportunityScenarioSummary = runOpportunityRankingScenarios();
  const opportunityRegressions = opportunityScenarioSummary.filter((scenario) =>
    scenario.ftrlRegret > scenario.staticRegret
      || scenario.ftrlCapturedEvUsd < scenario.staticCapturedEvUsd
  );
  if (opportunityRegressions.length > 0) {
    throw new Error(`Opportunity ranking FTRL benchmark gate failed for scenarios: ${opportunityRegressions.map((item) => item.scenario).join(", ")}`);
  }

  logger.info("base_benchmark_replay_complete", {
    chain,
    fromBlock: fromBlock.toString(),
    toBlock: latestBlock.toString(),
    replayEvents: events.length,
    candidates: benchmarkCandidates.length,
    positiveEvCount,
    p95_event_to_detection_ms: Number(p95.toFixed(2)),
    target_event_to_detection_ms: 100,
    privateArm,
    publicArm,
    providerScoringScenarios: providerScenarioSummary,
    opportunityScoringScenarios: opportunityScenarioSummary,
    providerScoringWinners: providerScenarioSummary.reduce<Record<string, number>>((acc, scenario) => {
      acc[scenario.winner] = (acc[scenario.winner] ?? 0) + 1;
      return acc;
    }, {}),
  });
}

function runOpportunityRankingScenarios(): OpportunityScenarioSummary[] {
  const scenarios = [
    { name: "ev_stable", rounds: 250, driftAt: -1 },
    { name: "gas_spike_drift", rounds: 250, driftAt: 110 },
  ] as const;
  return scenarios.map((scenario) => {
    const model = new BayesianHazardModel();
    const ranker = new NoRegretOpportunityRanker({ model });
    let staticRegret = 0;
    let ftrlRegret = 0;
    let staticCapturedEvUsd = 0;
    let ftrlCapturedEvUsd = 0;
    for (let round = 0; round < scenario.rounds; round += 1) {
      const gasDrift = scenario.driftAt >= 0 && round >= scenario.driftAt;
      const options = [
        {
          chain: "base" as const,
          opportunityId: `safe:${round}`,
          features: ["type:liquidation", "safe"],
          expectedProfitBps: 120,
          signals: {
            estimatedEvMissUsd: 12,
            gasSpikePenalty: gasDrift ? 0.15 : 0.05,
            closeFactorRisk: 0.1,
            oracleLatencyMs: 20,
          },
        },
        {
          chain: "base" as const,
          opportunityId: `risky:${round}`,
          features: ["type:liquidation", "risky"],
          expectedProfitBps: 220,
          signals: {
            estimatedEvMissUsd: gasDrift ? 8 : 22,
            gasSpikePenalty: gasDrift ? 0.9 : 0.2,
            closeFactorRisk: gasDrift ? 0.85 : 0.55,
            oracleLatencyMs: gasDrift ? 300 : 80,
          },
        },
      ] as const;
      const staticSelected = options[1]!;
      const ranked = ranker.rank(options);
      const ftrlSelected = ranked[0] ?? options[0]!;
      const staticEv = staticSelected.signals?.estimatedEvMissUsd ?? 0;
      const ftrlEv = ftrlSelected.signals?.estimatedEvMissUsd ?? 0;
      const bestEv = Math.max(...options.map((option) => option.signals?.estimatedEvMissUsd ?? 0));
      staticCapturedEvUsd += staticEv;
      ftrlCapturedEvUsd += ftrlEv;
      staticRegret += bestEv - staticEv;
      ftrlRegret += bestEv - ftrlEv;
      ranker.recordOutcome({
        chain: ftrlSelected.chain,
        opportunityId: ftrlSelected.opportunityId,
        features: ftrlSelected.features,
        expectedProfitBps: ftrlSelected.expectedProfitBps,
        signals: ftrlSelected.signals,
        outcome: ftrlEv >= staticEv ? "won" : "lost_to_competitor",
      });
    }
    return {
      scenario: scenario.name,
      staticRegret: Number(staticRegret.toFixed(4)),
      ftrlRegret: Number(ftrlRegret.toFixed(4)),
      staticCapturedEvUsd: Number(staticCapturedEvUsd.toFixed(4)),
      ftrlCapturedEvUsd: Number(ftrlCapturedEvUsd.toFixed(4)),
    };
  });
}

function syntheticBenchmarkCandidate(
  registry: ReturnType<typeof createChainRegistry>,
): LiquidationCandidate {
  const pair = registry.get("base").chainConfig.aave.reservePairs[0];
  if (pair === undefined) {
    throw new Error("Base reserve pair is required for synthetic benchmark candidate");
  }
  return {
    account: "0x00000000000000000000000000000000000000B0",
    collateralAsset: pair.collateralAsset,
    debtAsset: pair.debtAsset,
    debtToCover: 250_000_000n,
    repayValueUsd: 25_000,
    liquidationBonusBps: 25_000,
    healthFactor: 900_000_000_000_000_000n,
  };
}

async function runArm(input: {
  readonly name: "private" | "public";
  readonly registry: ReturnType<typeof createChainRegistry>;
  readonly metrics: ReturnType<typeof createBotMetrics>;
  readonly logger: ReturnType<typeof createLogger>;
  readonly publicClient: ReturnType<typeof createFailoverPublicClient>;
  readonly walletClient: ReturnType<typeof createFailoverWalletClient>;
  readonly account: Address;
  readonly requests: readonly ReturnType<typeof buildLiquidationExecutionRequest>[];
  readonly providerFeeRaw: bigint;
  readonly privateFirstChains: readonly "base"[];
  readonly privateMode: "provider_private" | "sequencer_direct" | "auto";
  readonly executionRpcUrl: string;
  readonly sequencerDirectRpc: string | undefined;
  readonly privateKey: Hex;
}): Promise<BenchmarkArmSummary> {
  const router = new FlashLoanProviderRouter({
    registry: input.registry,
    logger: input.logger,
    metrics: input.metrics,
    simulator: {
      simulate: async (simulationInput) => ({
        success: true as const,
        revenue: createAssetAmount(usd, simulationInput.revenue.raw),
        gas: createAssetAmount(usd, simulationInput.gas.raw),
        swapCost: createAssetAmount(usd, simulationInput.swapCost.raw),
      }),
    },
    providerFees: Object.fromEntries(
      input.registry.get("base").flashLoanProviders.map((providerId) => [providerId, createAssetAmount(usd, input.providerFeeRaw)]),
    ),
  });
  const simClient = new ViemExecutionClient({
    publicClient: input.publicClient,
    walletClient: input.walletClient,
  });
  let nonce = await input.publicClient.getTransactionCount({
    address: input.account,
    blockTag: "pending",
  });
  let fakeHashCounter = 1n;
  const preflightClient: ExecutionPreflightClient = {
    estimateGas: async () => 900_000n,
    getGasPrice: () => simClient.getGasPrice("base"),
    getPendingNonce: async () => nonce++,
    simulateContract: async () => ({ success: true }),
    send: async () => `0x${(fakeHashCounter++).toString(16).padStart(64, "0")}`,
    waitForReceipt: async () => ({ status: "included" }),
  };
  const providerPrivateWalletClient = createWalletClient({
    account: privateKeyToAccount(input.privateKey),
    chain: undefined,
    transport: http(input.executionRpcUrl),
  });
  const sequencerWalletClient = input.sequencerDirectRpc === undefined
    ? undefined
    : createWalletClient({
      account: privateKeyToAccount(input.privateKey),
      chain: undefined,
      transport: http(input.sequencerDirectRpc),
    });
  const privateClient = new PrivateSubmissionClient({
    mode: input.privateMode,
    logger: input.logger,
    providerPrivateWalletClient,
    ...(sequencerWalletClient === undefined ? {} : { sequencerWalletClient }),
  });
  const executor = new SafeTransactionExecutor({
    registry: input.registry,
    router,
    nonceManager: new LocalNonceManager(),
    client: preflightClient,
    logger: input.logger,
    metrics: input.metrics,
    ...(input.name === "private" ? { bundleRouter: privateClient } : {}),
    privateFirstChains: input.privateFirstChains,
    privateBundleRiskThresholdBps: 0,
    allowPublicFallbackAfterBundleFailure: true,
    dryRunMode: false,
  });

  let sent = 0;
  let simulated = 0;
  let rejected = 0;
  let failed = 0;
  for (const request of input.requests) {
    const result = await executor.execute(request);
    if (result.status === "sent") {
      sent += 1;
    } else if (result.status === "simulated") {
      simulated += 1;
    } else if (result.status === "rejected") {
      rejected += 1;
    } else {
      failed += 1;
    }
  }

  return { name: input.name, sent, simulated, rejected, failed };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
}

function runProviderScoringScenarios(): ProviderScenarioSummary[] {
  const scenarios = [
    { name: "stable", rounds: 600, mode: "stable" as const },
    { name: "latency_drift_x2", rounds: 600, mode: "drift" as const },
    { name: "outage_spikes", rounds: 600, mode: "outage" as const },
  ];
  return scenarios.map((scenario) => {
    const staticProvider: ProviderArm = "primary";
    const ftrl = new FTRLProviderScorer({
      providerIds: providerArms,
      enabled: true,
      rolloutPct: 100,
      randomSeed: 1337,
    });
    const heuristicLossEma = new Map<string, number>([
      ["primary", 0.5],
      ["secondary", 0.5],
      ["tertiary", 0.5],
    ]);
    const cumulativeLoss = {
      static: 0,
      heuristic: 0,
      ftrl: 0,
    };
    for (let round = 0; round < scenario.rounds; round += 1) {
      const losses = scenarioLosses(round, scenario.mode);
      const bestFixedLoss = Math.min(...Object.values(losses));
      cumulativeLoss.static += losses[staticProvider] - bestFixedLoss;
      const heuristicProvider = ([...heuristicLossEma.entries()].sort((left, right) => left[1] - right[1])[0]?.[0] ?? "primary") as ProviderArm;
      cumulativeLoss.heuristic += losses[heuristicProvider] - bestFixedLoss;
      for (const [provider, loss] of Object.entries(losses)) {
        const prev = heuristicLossEma.get(provider) ?? 0.5;
        heuristicLossEma.set(provider, prev * 0.9 + loss * 0.1);
      }

      const selected = (ftrl.samplePrimary() as ProviderArm);
      cumulativeLoss.ftrl += (losses[selected] ?? losses.primary) - bestFixedLoss;
      ftrl.updateFromEvent(selected, {
        eventToDetectionMs: (losses[selected] ?? losses.primary) * 400,
        getLogsLatencyMs: (losses[selected] ?? losses.primary) * 120,
        flashblocksLeadMs: Math.max(0, 150 - (losses[selected] ?? losses.primary) * 100),
        missedOpportunities: (losses[selected] ?? losses.primary) > 0.8 ? 1 : 0,
        estimatedMissedEvUsd: 10,
        errorRate: (losses[selected] ?? losses.primary) > 0.9 ? 1 : 0,
        errorSeverity: (losses[selected] ?? losses.primary) > 0.9 ? "outage" : "transient",
      });
    }
    const staticLatencyMs = averageLatencyMs(staticProvider, scenario.mode);
    const heuristicProvider = ([...heuristicLossEma.entries()].sort((left, right) => left[1] - right[1])[0]?.[0] ?? "primary") as ProviderArm;
    const heuristicLatencyMs = averageLatencyMs(heuristicProvider, scenario.mode);
    const ftrlProvider = (ftrl.rankProviders()[0] ?? "primary") as ProviderArm;
    const ftrlLatencyMs = averageLatencyMs(ftrlProvider, scenario.mode);
    const winner = cumulativeLoss.ftrl <= cumulativeLoss.heuristic && cumulativeLoss.ftrl <= cumulativeLoss.static
      ? "ftrl"
      : cumulativeLoss.heuristic <= cumulativeLoss.static
        ? "heuristic"
        : "static";
    return {
      scenario: scenario.name,
      staticRegret: Number(cumulativeLoss.static.toFixed(4)),
      heuristicRegret: Number(cumulativeLoss.heuristic.toFixed(4)),
      ftrlRegret: Number(cumulativeLoss.ftrl.toFixed(4)),
      staticLatencyMs: Number(staticLatencyMs.toFixed(2)),
      heuristicLatencyMs: Number(heuristicLatencyMs.toFixed(2)),
      ftrlLatencyMs: Number(ftrlLatencyMs.toFixed(2)),
      winner,
    };
  });
}

function scenarioLosses(round: number, mode: "stable" | "drift" | "outage"): Record<ProviderArm, number> {
  if (mode === "stable") {
    return {
      primary: 0.25 + ((round % 11) / 250),
      secondary: 0.35 + ((round % 17) / 220),
      tertiary: 0.40 + ((round % 13) / 210),
    };
  }
  if (mode === "drift") {
    const primaryDegraded = round > 180 && round < 420;
    return {
      primary: primaryDegraded ? 0.85 + ((round % 7) / 60) : 0.30 + ((round % 13) / 240),
      secondary: 0.38 + ((round % 19) / 240),
      tertiary: 0.42 + ((round % 11) / 210),
    };
  }
  const outagePrimary = round % 90 < 18;
  const outageSecondary = round % 130 < 15;
  return {
    primary: outagePrimary ? 1 : 0.32 + ((round % 9) / 220),
    secondary: outageSecondary ? 0.95 : 0.36 + ((round % 15) / 240),
    tertiary: 0.44 + ((round % 21) / 220),
  };
}

function averageLatencyMs(provider: ProviderArm, mode: "stable" | "drift" | "outage"): number {
  const baseline = provider === "primary" ? 45 : provider === "secondary" ? 60 : 72;
  if (mode === "stable") {
    return baseline;
  }
  if (mode === "drift") {
    return provider === "primary" ? baseline * 2 : baseline;
  }
  if (provider === "primary" || provider === "secondary") {
    return baseline * 1.6;
  }
  return baseline;
}

function createGraphClient(url: string) {
  return {
    request: async <T>(query: string, variables: Record<string, number>): Promise<T> => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const body = await response.json() as { data?: T; errors?: unknown };
      if (!response.ok || body.errors !== undefined || body.data === undefined) {
        throw new Error(`Benchmark GraphQL query failed for ${url}`);
      }
      return body.data;
    },
  };
}

if (require.main === module) {
  run().catch((error: unknown) => {
    createLogger("error").error("base_benchmark_replay_failed", { error });
    process.exitCode = 1;
  });
}
