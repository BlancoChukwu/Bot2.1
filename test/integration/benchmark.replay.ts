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
