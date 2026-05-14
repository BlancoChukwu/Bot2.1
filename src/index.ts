import "dotenv/config";
import { createWalletClient, http, parseAbiItem, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  createBotMetrics,
  createLogger,
  LiquidationBot,
  type PollingLoopOptions,
  startMetricsServer,
  type BotMetrics,
  type LoggerLike,
} from "./bot";
import {
  aaveV3TheGraphSubgraphIds,
  createFailoverPublicClient,
  createFailoverWalletClient,
  createChainWebSocketPublicClient,
  getChainConfig,
  parseSupportedChain,
  type ChainConfig,
  type SupportedChain,
} from "./config/chains";
import { createChainRegistry } from "./config/chainRegistry";
import type { FlashLoanProviderId } from "./config/chainRegistry";
import { createLiquidationActions, LiquidationExecutor } from "./executors/liquidationExecutor";
import { buildArbitrageExecutionRequest } from "./executors/arbitrageExecutorAdapter";
import { buildLiquidationExecutionRequest } from "./executors/liquidationExecutionAdapter";
import { LocalNonceManager } from "./executors/nonceManager";
import { PrivateSubmissionClient, type PrivateTxMode } from "./executors/PrivateSubmissionClient";
import { SafeTransactionExecutor } from "./executors/safeTransactionExecutor";
import { ViemExecutionClient } from "./executors/viemExecutionClient";
import { getDexesForChain, getMonitoredPairsForChain } from "./config/dexRegistry";
import { HealthFactorMonitor } from "./monitors/healthFactorMonitor";
import { ArbitrageOpportunityQueue } from "./monitors/arbitrageOpportunityQueue";
import { ArbitrageScanner } from "./monitors/arbitrageScanner";
import { AaveSnapshotProvider } from "./monitors/aaveSnapshotProvider";
import { HybridDetectionPipeline } from "./monitors/hybridDetectionPipeline";
import { MultiWsEventSource } from "./monitors/MultiWsEventSource";
import { createReserveAwareCandidates, ReserveAwareBorrowerCache } from "./monitors/reserveAwareBorrowerCache";
import { PipelineDetectionAdapter } from "./orchestrator/pipelineDetectionAdapter";
import { PipelineDeadLetterQueue, PipelineOrchestrator } from "./orchestrator/pipelineOrchestrator";
import { BayesianHazardModel, NoRegretOpportunityRanker } from "./optimization/hazardPrediction";
import { buildLiquidationCallParams, ViemAaveV3Protocol } from "./protocols/aaveV3";
import { FlashLoanProviderRouter } from "./profitability/flashLoanProviderRouter";
import { ProfitabilityEngine } from "./profitability/profitabilityEngine";
import { ReplayHarness } from "./backtesting/replayHarness";
import { MIN_PROFIT_THRESHOLD_WEI } from "./utils/evCalculator";
import { GasPriceOracle } from "./utils/gasPriceOracle";
import { createAsset, createAssetAmount } from "./utils/typedAssetMath";
import { PriceOracleCache, type OracleFeedRegistry } from "./utils/priceOracleCache";
import { sendDailyPnlSummary, sendLiquidationAlert } from "./utils/telegramAlert";
import { assertLiquidationReceiverReadiness } from "./production/liquidationReceiverReadiness";
import { DeploymentSafetyGate, type DeploymentGateResult, type DryRunValidationReceipt } from "./production/productionReadiness";
import { PnlTracker } from "./production/pnlTracker";
import type { Opportunity } from "./types/opportunity";

/**
 * Live arbitrage startup guards:
 * 1) Feed coverage guard: required token feeds must exist in registry config.
 * 2) Feed value guard: required token feeds must return positive, non-stale prices at startup.
 */
export interface RuntimeConfig {
  readonly chain: SupportedChain;
  readonly chains: readonly SupportedChain[];
  readonly rpcUrl: string;
  readonly fallbackRpcUrls: readonly string[];
  readonly wsRpcUrl: string | undefined;
  readonly wsRpcUrlPrimary: string | undefined;
  readonly wsRpcUrlSecondary: string | undefined;
  readonly wsRpcUrlTertiary: string | undefined;
  readonly executionRpcUrlPrimary: string;
  readonly executionRpcFallbackUrls: readonly string[];
  readonly sequencerUptimeFeed: Address | undefined;
  readonly sequencerDirectRpc: string | undefined;
  readonly flashblocksEnabled: boolean;
  readonly flashLoanProviders: readonly FlashLoanProviderId[];
  readonly privateTxMode: PrivateTxMode;
  /** Resolved subgraph URL for `chain` (first entry in `chains`). */
  readonly aaveSubgraphUrl: string;
  /** Resolved Aave V3 subgraph GraphQL URL for each configured chain (pipeline / per-chain RPC). */
  readonly aaveSubgraphByChain: ReadonlyMap<SupportedChain, string>;
  readonly privateKey: Hex;
  readonly pollIntervalMs: number;
  readonly candidateCooldownMs: number;
  readonly minProfitWei: bigint;
  readonly minProfitUsd: number;
  readonly gasCostUsd: number;
  readonly slippageBps: number;
  readonly minProfitMarginBps: number;
  readonly flashLoanFeeBps: number;
  readonly flashLoanSlippageFloorBps: number;
  readonly gasOracleCacheMs: number;
  readonly simulationMode: boolean;
  readonly telegramBotToken: string | undefined;
  readonly telegramChatId: string | undefined;
  readonly pagerDutyRoutingKey: string | undefined;
  readonly dryRunValidation: DryRunValidationReceipt | undefined;
  readonly logLevel: string;
  readonly usePipelineOrchestrator: boolean;
  readonly arbitrageReceiverAddress: Address | undefined;
  readonly liquidationReceiverAddress: Address | undefined;
  readonly dailyPnlCsvPath: string | undefined;
  readonly arbitrageMinProfitUsd: number;
  readonly priceFeedRegistry: OracleFeedRegistry | undefined;
}

export interface BotRunner {
  runPollingLoop(options: PollingLoopOptions): Promise<void>;
}

type Env = Record<string, string | undefined>;

const runtimeEnvSchema = z.record(z.string(), z.string().optional());
/** Live mode: Aave-style risk floor (0.5%). */
const minimumProfitMarginBpsLive = 50;
/** Simulation: lower floor so quotes / approvals are easier to observe (raise before live). */
const minimumProfitMarginBpsSimulation = 40;
const defaultProfitMarginBps = 50;
const defaultFlashLoanFeeBps = 9;
const defaultFlashLoanSlippageFloorBps = 500;
const placeholderPrivateKey = "0x0000000000000000000000000000000000000000000000000000000000000000";
const canonicalBaseUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const canonicalBaseWeth = "0x4200000000000000000000000000000000000006" as Address;
const canonicalBaseCbBtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;
const canonicalBaseUsdcUsdFeed = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B" as Address;
const canonicalBaseEthUsdFeed = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as Address;
const canonicalBaseCbBtcUsdFeed = "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D" as Address;

export function parseRuntimeConfig(env: Env): RuntimeConfig {
  const parsedEnv = parseRuntimeEnv(env);
  const chains = parseSupportedChains(parsedEnv);
  const chain = firstSupportedChain(chains);
  const rpcUrl = requireEnv(parsedEnv, "RPC_URL");
  const aaveSubgraphByChain = new Map(
    chains.map((c) => [c, resolveAaveSubgraphUrlForChain(parsedEnv, c)] as const),
  );
  const aaveSubgraphUrl = aaveSubgraphByChain.get(chain)!;
  const subgraphFingerprint = buildAaveSubgraphFingerprint(chains, aaveSubgraphByChain);
  const privateKey = parsePrivateKey(requireEnv(parsedEnv, "PRIVATE_KEY"));
  const simulationMode = parseBoolean(parsedEnv.SIMULATION_MODE, true);
  if (!simulationMode && privateKey.toLowerCase() === placeholderPrivateKey) {
    throw new Error("PRIVATE_KEY uses the placeholder private key and cannot run in live mode");
  }

  const minProfitMarginFloorBps = simulationMode ? minimumProfitMarginBpsSimulation : minimumProfitMarginBpsLive;

  const usePipelineOrchestrator = parseBoolean(parsedEnv.USE_PIPELINE_ORCHESTRATOR, false);
  const priceFeedRegistry = parsePriceFeedRegistry(parsedEnv.PRICE_FEED_REGISTRY_JSON) ?? defaultPriceFeedRegistry();
  const config: RuntimeConfig = {
    chain,
    chains,
    rpcUrl,
    aaveSubgraphUrl,
    aaveSubgraphByChain,
    privateKey,
    fallbackRpcUrls: parseList(parsedEnv.FALLBACK_RPC_URLS),
    wsRpcUrl: optionalEnv(parsedEnv, "WS_RPC_URL"),
    wsRpcUrlPrimary: optionalEnv(parsedEnv, "WS_RPC_URL_PRIMARY") ?? optionalEnv(parsedEnv, "WS_RPC_URL"),
    wsRpcUrlSecondary: optionalEnv(parsedEnv, "WS_RPC_URL_SECONDARY"),
    wsRpcUrlTertiary: optionalEnv(parsedEnv, "WS_RPC_URL_TERTIARY"),
    executionRpcUrlPrimary: optionalEnv(parsedEnv, "EXECUTION_RPC_URL_PRIMARY") ?? rpcUrl,
    executionRpcFallbackUrls: parseList(parsedEnv.EXECUTION_RPC_URL_FALLBACKS),
    sequencerUptimeFeed: parseAddress(optionalEnv(parsedEnv, "SEQUENCER_UPTIME_FEED")),
    sequencerDirectRpc: optionalEnv(parsedEnv, "SEQUENCER_DIRECT_RPC"),
    flashblocksEnabled: parseBoolean(parsedEnv.FLASHBLOCKS_ENABLED, false),
    flashLoanProviders: parseFlashLoanProviders(parsedEnv.FLASH_LOAN_PROVIDERS),
    privateTxMode: parsePrivateTxMode(optionalEnv(parsedEnv, "PRIVATE_TX_MODE")),
    pollIntervalMs: parseMinNumber(parsedEnv.POLL_INTERVAL_MS, 400, 100, "POLL_INTERVAL_MS"),
    candidateCooldownMs: parseMinNumber(parsedEnv.CANDIDATE_COOLDOWN_MS, 30_000, 0, "CANDIDATE_COOLDOWN_MS"),
    minProfitWei: parseEthThreshold(parsedEnv.MIN_PROFIT_THRESHOLD_ETH),
    minProfitUsd: parseMinNumber(parsedEnv.MIN_PROFIT_USD, 10, 0, "MIN_PROFIT_USD"),
    gasCostUsd: parseMinNumber(parsedEnv.GAS_COST_USD, 0, 0, "GAS_COST_USD"),
    slippageBps: parseMinNumber(parsedEnv.SLIPPAGE_BPS, 50, 0, "SLIPPAGE_BPS"),
    minProfitMarginBps: parseMinNumber(
      parsedEnv.MIN_PROFIT_MARGIN_BPS,
      defaultProfitMarginBps,
      minProfitMarginFloorBps,
      "MIN_PROFIT_MARGIN_BPS",
    ),
    flashLoanFeeBps: parseMinNumber(
      parsedEnv.FLASH_LOAN_FEE_BPS,
      defaultFlashLoanFeeBps,
      0,
      "FLASH_LOAN_FEE_BPS",
    ),
    flashLoanSlippageFloorBps: parseMinNumber(
      parsedEnv.FLASH_LOAN_SLIPPAGE_FLOOR_BPS,
      defaultFlashLoanSlippageFloorBps,
      0,
      "FLASH_LOAN_SLIPPAGE_FLOOR_BPS",
    ),
    gasOracleCacheMs: parseMinNumber(parsedEnv.GAS_ORACLE_CACHE_MS, 30_000, 1, "GAS_ORACLE_CACHE_MS"),
    simulationMode,
    telegramBotToken: optionalEnv(parsedEnv, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: optionalEnv(parsedEnv, "TELEGRAM_CHAT_ID"),
    pagerDutyRoutingKey: optionalEnv(parsedEnv, "PAGERDUTY_ROUTING_KEY"),
    dryRunValidation: parseDryRunValidation(parsedEnv, chains, privateKey, subgraphFingerprint),
    logLevel: parsedEnv.LOG_LEVEL ?? "info",
    usePipelineOrchestrator,
    arbitrageReceiverAddress: parseAddress(optionalEnv(parsedEnv, "ARBITRAGE_RECEIVER_ADDRESS")),
    liquidationReceiverAddress: parseAddress(optionalEnv(parsedEnv, "LIQUIDATION_RECEIVER_ADDRESS")),
    dailyPnlCsvPath: optionalEnv(parsedEnv, "DAILY_PNL_CSV_PATH"),
    arbitrageMinProfitUsd: parseMinNumber(parsedEnv.ARBITRAGE_MIN_PROFIT_USD, 0.15, 0, "ARBITRAGE_MIN_PROFIT_USD"),
    priceFeedRegistry,
  };
  assertPipelineFlashLiquidationReadiness(config);
  assertArbitragePriceFeedCoverage(config);
  return config;
}

export function evaluateRuntimeDeploymentSafety(config: RuntimeConfig): DeploymentGateResult {
  return new DeploymentSafetyGate().evaluate({
    simulationMode: config.simulationMode,
    hasPagerDutyRoutingKey: config.pagerDutyRoutingKey !== undefined,
    hasMetricsEndpoint: true,
    registeredChains: config.chains,
    minProfitMarginBps: config.minProfitMarginBps,
    ...(config.dryRunValidation === undefined ? {} : { dryRunValidation: config.dryRunValidation }),
  });
}

export function buildBot(config: RuntimeConfig, metrics: BotMetrics = createBotMetrics()): BotRunner {
  if (!config.usePipelineOrchestrator && !config.simulationMode) {
    throw new Error("Live mode requires USE_PIPELINE_ORCHESTRATOR=true to enforce flash-loan-first execution");
  }
  if (config.usePipelineOrchestrator) {
    return buildPipelineBot(config, metrics);
  }

  const chainConfig = getChainConfig(config.chain);
  const logger = createLogger(config.logLevel);
  const publicClient = createFailoverPublicClient({
    chain: config.chain,
    rpcUrl: config.executionRpcUrlPrimary,
    fallbackRpcUrls: config.executionRpcFallbackUrls.length > 0 ? config.executionRpcFallbackUrls : config.fallbackRpcUrls,
  });
  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createFailoverWalletClient({
    chain: config.chain,
    rpcUrl: config.executionRpcUrlPrimary,
    fallbackRpcUrls: config.executionRpcFallbackUrls.length > 0 ? config.executionRpcFallbackUrls : config.fallbackRpcUrls,
    privateKey: config.privateKey,
  });
  const eventClient = config.wsRpcUrl === undefined
    ? publicClient
    : createChainWebSocketPublicClient({ chain: config.chain, wsRpcUrl: config.wsRpcUrl });
  const singleChainRegistry = createChainRegistry({
    chains: [{
      chain: config.chain,
      rpcUrl: config.executionRpcUrlPrimary,
      fallbackRpcUrls: config.executionRpcFallbackUrls.length > 0 ? config.executionRpcFallbackUrls : config.fallbackRpcUrls,
      ...(config.wsRpcUrl === undefined ? {} : { wsRpcUrl: config.wsRpcUrl }),
      aaveSubgraphUrl: config.aaveSubgraphUrl,
      flashLoanProviders: config.flashLoanProviders,
    }],
  });
  const protocol = new ViemAaveV3Protocol(
    publicClient,
    chainConfig,
    createGraphClient(config.aaveSubgraphUrl),
    eventClient,
    50,
    singleChainRegistry,
  );
  const monitor = new HealthFactorMonitor({
    protocol,
    pollIntervalMs: config.pollIntervalMs,
    candidateCooldownMs: config.candidateCooldownMs,
    minProfitUsd: config.minProfitUsd,
    gasCostUsd: config.gasCostUsd,
    slippageBps: config.slippageBps,
    logger,
  });
  const actions = createLiquidationActions({
    pool: chainConfig.aave.pool,
    account: account.address,
    publicClient,
    walletClient,
  });
  const executor = new LiquidationExecutor({
    minProfitWei: config.minProfitWei,
    simulationMode: config.simulationMode,
    estimateGas: (candidate) =>
      publicClient.estimateContractGas({
        ...buildLiquidationCallParams(candidate, chainConfig.aave.pool),
        account: account.address,
      }),
    getGasPrice: () => publicClient.getGasPrice(),
    getNonce: () => publicClient.getTransactionCount({ address: account.address }),
    simulate: actions.simulate,
    send: actions.send,
    logger,
  });

  installProcessErrorHandlers(logger);
  return new LiquidationBot({
    monitor,
    executor,
    logger,
    minProfitWei: config.minProfitWei,
    simulationMode: config.simulationMode,
    metrics,
    alert: (event) =>
      sendLiquidationAlert({
        token: config.telegramBotToken,
        chatId: config.telegramChatId,
        candidate: event.candidate,
        mode: event.mode,
        evProfitWei: event.evProfitWei,
        ...(event.txHash === undefined ? {} : { txHash: event.txHash }),
      }),
  });
}

function buildPipelineBot(config: RuntimeConfig, metrics: BotMetrics): BotRunner {
  const logger = createLogger(config.logLevel);
  const account = privateKeyToAccount(config.privateKey);
  const resolvedAaveCache = loadResolvedAaveAddressCache();
  const registry = createChainRegistry({
    chains: config.chains.map((chainName) => ({
      chain: chainName,
      rpcUrl: config.rpcUrl,
      fallbackRpcUrls: config.fallbackRpcUrls,
      ...(config.wsRpcUrl === undefined ? {} : { wsRpcUrl: config.wsRpcUrl }),
      detection: {
        ...(config.wsRpcUrlPrimary === undefined ? {} : { wsPrimary: config.wsRpcUrlPrimary }),
        ...(config.wsRpcUrlSecondary === undefined ? {} : { wsSecondary: config.wsRpcUrlSecondary }),
        ...(config.wsRpcUrlTertiary === undefined ? {} : { wsTertiary: config.wsRpcUrlTertiary }),
        flashblocksEnabled: config.flashblocksEnabled,
      },
      execution: {
        httpPrimary: config.executionRpcUrlPrimary,
        fallbacks: config.executionRpcFallbackUrls,
      },
      sequencer: {
        ...(config.sequencerUptimeFeed === undefined ? {} : { uptimeFeed: config.sequencerUptimeFeed }),
        ...(config.sequencerDirectRpc === undefined ? {} : { directRpc: config.sequencerDirectRpc }),
      },
      ...(resolvedAaveCache[chainName] === undefined ? {} : { resolvedAave: resolvedAaveCache[chainName] }),
      aaveSubgraphUrl: config.aaveSubgraphByChain.get(chainName)!,
      flashLoanProviders: config.flashLoanProviders,
    })),
  });
  const cachedResolvedForActive = resolvedAaveCache[config.chain];
  let activeChainConfig = withResolvedAave(getChainConfig(config.chain), cachedResolvedForActive);
  let activePoolAddress = activeChainConfig.aave.pool;
  const publicClient = createFailoverPublicClient({
    chain: config.chain,
    rpcUrl: config.executionRpcUrlPrimary,
    fallbackRpcUrls: config.executionRpcFallbackUrls.length > 0 ? config.executionRpcFallbackUrls : config.fallbackRpcUrls,
  });
  const walletClient = createFailoverWalletClient({
    chain: config.chain,
    rpcUrl: config.executionRpcUrlPrimary,
    fallbackRpcUrls: config.executionRpcFallbackUrls.length > 0 ? config.executionRpcFallbackUrls : config.fallbackRpcUrls,
    privateKey: config.privateKey,
  });
  const eventClient = config.wsRpcUrlPrimary === undefined
    ? publicClient
    : createChainWebSocketPublicClient({ chain: config.chain, wsRpcUrl: config.wsRpcUrlPrimary });
  const protocol = new ViemAaveV3Protocol(
    publicClient,
    activeChainConfig,
    createGraphClient(config.aaveSubgraphUrl),
    eventClient,
    50,
    registry,
  );
  const chainConfig = activeChainConfig;
  const priceOracleCache = config.priceFeedRegistry === undefined
    ? undefined
    : new PriceOracleCache({
      publicClient,
      chain: config.chain,
      feedRegistry: config.priceFeedRegistry,
      logger,
    });
  let resolvedFlashLoanFeeBpsPromise: Promise<number> | undefined;
  const resolveFlashLoanFeeBps = async (): Promise<number> => {
    if (resolvedFlashLoanFeeBpsPromise === undefined) {
      resolvedFlashLoanFeeBpsPromise = readFlashLoanPremiumBps({
        publicClient,
        pool: chainConfig.aave.pool,
        fallbackBps: config.flashLoanFeeBps,
        logger,
      });
    }
    return resolvedFlashLoanFeeBpsPromise;
  };
  const gasPriceOracle = new GasPriceOracle({
    client: {
      getGasPrice: async () => publicClient.getGasPrice(),
    },
    ttlMs: config.gasOracleCacheMs,
  });
  const resolveDynamicGasCostUsd = async (): Promise<number> => {
    if (priceOracleCache === undefined) {
      return config.gasCostUsd;
    }
    const gasPrice = await gasPriceOracle.getGasPrice();
    const nativeToken = nativeGasTokenForChain(config.chain);
    const prices = await priceOracleCache.batchGetUsdPrices([nativeToken]);
    const nativePriceRaw = prices[nativeToken] ?? 0n;
    if (nativePriceRaw <= 0n) {
      return config.gasCostUsd;
    }
    const gasCostWei = gasPrice * 500_000n;
    const gasCostUsdRaw = (gasCostWei * nativePriceRaw) / 1_000_000_000_000_000_000n;
    return Number(gasCostUsdRaw) / 1e8;
  };
  const resolveDynamicSlippageBps = async (): Promise<number> => {
    const gasPrice = await gasPriceOracle.getGasPrice();
    const gasGwei = Number(gasPrice) / 1e9;
    if (!Number.isFinite(gasGwei)) {
      return config.slippageBps;
    }
    if (gasGwei >= 10) {
      return config.slippageBps + 120;
    }
    if (gasGwei >= 3) {
      return config.slippageBps + 60;
    }
    return config.slippageBps;
  };
  const monitor = new HealthFactorMonitor({
    protocol,
    pollIntervalMs: config.pollIntervalMs,
    candidateCooldownMs: config.candidateCooldownMs,
    minProfitUsd: config.minProfitUsd,
    gasCostUsd: config.gasCostUsd,
    resolveDynamicGasCostUsd,
    slippageBps: config.slippageBps,
    resolveDynamicSlippageBps,
    logger,
  });

  const usd = createAsset({ symbol: "USD", decimals: 8 });
  const simulator = {
    simulate: async (input: {
      revenue: { raw: bigint };
      gas: { raw: bigint };
      swapCost: { raw: bigint };
    }) => ({
      success: true as const,
      revenue: createAssetAmount(usd, input.revenue.raw),
      gas: createAssetAmount(usd, input.gas.raw),
      swapCost: createAssetAmount(usd, input.swapCost.raw),
    }),
  };
  const router = new FlashLoanProviderRouter({
    registry,
    logger,
    metrics,
    simulator,
    providerFees: {},
  });
  const providerPrivateWalletClient = config.executionRpcUrlPrimary === ""
    ? undefined
    : createWalletClient({
      account,
      chain: undefined,
      transport: http(config.executionRpcUrlPrimary),
    });
  const sequencerWalletClient = config.sequencerDirectRpc === undefined
    ? undefined
    : createWalletClient({
      account,
      chain: undefined,
      transport: http(config.sequencerDirectRpc),
    });
  const privateSubmissionClient = new PrivateSubmissionClient({
    mode: config.privateTxMode,
    logger,
    ...(providerPrivateWalletClient === undefined ? {} : { providerPrivateWalletClient }),
    ...(sequencerWalletClient === undefined ? {} : { sequencerWalletClient }),
  });
  const executor = new SafeTransactionExecutor({
    registry,
    router,
    nonceManager: new LocalNonceManager(),
    client: new ViemExecutionClient({ publicClient, walletClient }),
    logger,
    metrics,
    dryRunMode: config.simulationMode,
    privateBundleRiskThresholdBps: 7_000,
    allowPublicFallbackAfterBundleFailure: true,
    bundleRouter: privateSubmissionClient,
    privateFirstChains: config.chain === "base" ? ["base"] : [],
  });
  const arbQueue = new ArbitrageOpportunityQueue();
  const detectionSource = config.wsRpcUrlPrimary === undefined
    ? {
      start: async (handlers: { onReserveUpdated: (event: { chain: SupportedChain; reserve: Address }) => void; onError: (chain: SupportedChain, error: Error) => void }) => {
        const stop = await protocol.subscribeToReserveDataUpdated?.((reserve) => {
          if (reserve === undefined) {
            return;
          }
          handlers.onReserveUpdated({ chain: config.chain, reserve });
        });
        return stop ?? (() => undefined);
      },
    }
    : new MultiWsEventSource({
      registry,
      chain: config.chain,
      logger,
      metrics,
    });
  const hybridDetection = new HybridDetectionPipeline({
    registry,
    eventSource: detectionSource,
    provider: new AaveSnapshotProvider(config.chain, protocol, registry),
    logger,
    metrics,
  });
  const detection = new PipelineDetectionAdapter({
    chain: config.chain,
    monitor,
    hybridDetection,
    arbitrageQueue: arbQueue,
  });
  const arbScannerEngine = new ProfitabilityEngine({
    registry,
    logger,
    metrics,
    simulator,
  });
  const pnlTracker = config.dailyPnlCsvPath === undefined ? undefined : new PnlTracker(config.dailyPnlCsvPath);
  let lastSummaryDay = "";
  const arbitrageScanner = new ArbitrageScanner({
    registry,
    profitabilityEngine: arbScannerEngine,
    logger,
    metrics,
    publicClientFactory: (chain) =>
      createFailoverPublicClient({
        chain,
        rpcUrl: config.rpcUrl,
        fallbackRpcUrls: config.fallbackRpcUrls,
      }),
    getDexesForChain,
    getMonitoredPairsForChain,
    defaultFlashLoanProvider: "aaveV3",
    minProfitMarginBps: config.minProfitMarginBps,
    opportunitySink: arbQueue,
    ...(priceOracleCache === undefined ? {} : { exactUsdPriceCache: priceOracleCache }),
    exactUsdMinProfitRaw: BigInt(Math.trunc(config.arbitrageMinProfitUsd * 1e8)),
    ...(config.arbitrageReceiverAddress === undefined
      ? {}
      : { flashLoanReceiverAddress: config.arbitrageReceiverAddress, operatorAddress: account.address }),
  });
  const liquidationReceiver = config.liquidationReceiverAddress;
  const liquidationReceiverExpectedSwapRouter = parseAddress(
    process.env.LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER?.trim(),
  );
  const validateLiquidationReceiverRpc =
    liquidationReceiver !== undefined
    && parseBoolean(process.env.VALIDATE_LIQUIDATION_RECEIVER_RPC, !config.simulationMode);
  const startupGuard = async () => {
    const resolvedByChain = await resolveAndPersistAaveAddresses({
      chains: config.chains,
      publicClient,
      logger,
    });
    const resolvedActive = resolvedByChain[config.chain];
    if (resolvedActive !== undefined) {
      activeChainConfig = withResolvedAave(activeChainConfig, resolvedActive);
      activePoolAddress = activeChainConfig.aave.pool;
      logger.info("runtime_aave_addresses_resolved", {
        chain: config.chain,
        pool: activePoolAddress,
        provider: activeChainConfig.aave.poolAddressesProvider,
      });
    }
    const resolvedFlashLoanFeeBps = await resolveFlashLoanFeeBps();
    router.setProviderFee(
      "aaveV3",
      createAssetAmount(usd, BigInt(Math.trunc(resolvedFlashLoanFeeBps * 1_000_000))),
    );
    router.setProviderFee(
      "balancer",
      createAssetAmount(usd, BigInt(Math.trunc(config.flashLoanFeeBps * 1_000_000))),
    );
    if (validateLiquidationReceiverRpc) {
      const registryUniswap = getDexesForChain(config.chain).find((dex) => dex.name === "UniswapV3");
      const expectedSwapRouter = liquidationReceiverExpectedSwapRouter ?? registryUniswap?.router;
      if (expectedSwapRouter === undefined) {
        throw new Error(
          "Liquidation receiver RPC validation needs a swap router: set LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER or add UniswapV3 to dexRegistry for this chain",
        );
      }
      await assertLiquidationReceiverReadiness(publicClient, {
        chain: config.chain,
        receiver: liquidationReceiver,
        expectedSwapRouter,
      });
      logger.info("liquidation_receiver_startup_verified", {
        chain: config.chain,
        receiver: liquidationReceiver,
        swapRouter: expectedSwapRouter,
        swapRouterSource: liquidationReceiverExpectedSwapRouter !== undefined ? "env" : "dex_registry",
      });
    }
    if (priceOracleCache !== undefined) {
      await assertArbitrageOracleReadiness(config, priceOracleCache);
    }
  };
  const hazardModel = new BayesianHazardModel();
  const noRegretRanker = new NoRegretOpportunityRanker({ model: hazardModel });
  const orchestrator = new PipelineOrchestrator({
    registry,
    detection,
    executor,
    deadLetters: new PipelineDeadLetterQueue(),
    logger,
    metrics,
    sequencerGuard: {
      isUp: async (chain) => isSequencerUp({
        publicClient,
        feed: registry.get(chain).sequencer.uptimeFeed as Address | undefined,
        logger,
      }),
    },
    cycleObserver: async () => {
      const snapshot = metrics.snapshot();
      if (pnlTracker !== undefined) {
        pnlTracker.append({
          timestampIso: new Date().toISOString(),
          netProfitUsd: snapshot.netProfitUsd,
          arbitrageExecuted: snapshot.arbitrageExecuted,
          liquidationsExecuted: snapshot.liquidationsExecuted,
        });
      }
      const now = new Date();
      const dayKey = now.toISOString().slice(0, 10);
      if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5 && lastSummaryDay !== dayKey) {
        lastSummaryDay = dayKey;
        await sendDailyPnlSummary({
          token: config.telegramBotToken,
          chatId: config.telegramChatId,
          netProfitUsd: snapshot.netProfitUsd,
          arbitrageExecuted: snapshot.arbitrageExecuted,
          liquidationsExecuted: snapshot.liquidationsExecuted,
        });
      }
    },
    opportunityRanker: {
      rank: async (_chain, plans) => noRegretRanker.rank(
        plans.map((plan) => ({
          chain: plan.chain,
          opportunityId: plan.request.opportunityId,
          features: opportunityFeatures(plan.opportunity),
          expectedProfitBps: estimateOpportunityProfitBps(plan.opportunity),
          plan,
        })),
      ).map((entry) => entry.plan),
    },
    outcomeObserver: {
      recordOutcome: async (outcome) => {
        noRegretRanker.recordOutcome(outcome);
        logger.info("no_regret_outcome_recorded", {
          opportunityId: outcome.opportunityId,
          outcome: outcome.outcome,
          cumulativeRegret: noRegretRanker.cumulativeRegret(),
        });
      },
    },
    buildExecutionRequest: async (candidate) =>
      buildLiquidationExecutionRequest(config.chain, candidate, {
        account: account.address,
        minProfitUsd: config.minProfitUsd,
        gasCostUsd: await resolveDynamicGasCostUsd(),
        slippageBps: config.slippageBps,
        minimumMarginBps: config.minProfitMarginBps,
        flashFeeBps: await resolveFlashLoanFeeBps(),
        slippageBufferFloorBps: config.flashLoanSlippageFloorBps,
        requireFlashLoanWrapper: true,
        poolAddress: activePoolAddress,
        ...(config.liquidationReceiverAddress === undefined ? {} : { flashLoanReceiverAddress: config.liquidationReceiverAddress }),
      }),
    buildExecutionRequestForOpportunity: async (opportunity: Opportunity) => {
      if (opportunity.kind === "liquidation") {
        return buildLiquidationExecutionRequest(config.chain, opportunity.candidate, {
          account: account.address,
          minProfitUsd: config.minProfitUsd,
          gasCostUsd: await resolveDynamicGasCostUsd(),
          slippageBps: config.slippageBps,
          minimumMarginBps: config.minProfitMarginBps,
          flashFeeBps: await resolveFlashLoanFeeBps(),
          slippageBufferFloorBps: config.flashLoanSlippageFloorBps,
          requireFlashLoanWrapper: true,
          poolAddress: activePoolAddress,
          ...(config.liquidationReceiverAddress === undefined ? {} : { flashLoanReceiverAddress: config.liquidationReceiverAddress }),
        });
      }
      if (config.arbitrageReceiverAddress === undefined) {
        return undefined;
      }
      return buildArbitrageExecutionRequest(opportunity.candidate, {
        receiverAddress: config.arbitrageReceiverAddress,
        operatorAddress: account.address,
      });
    },
  });

  return new PipelineBotRunner(orchestrator, arbitrageScanner, startupGuard);
}

class PipelineBotRunner implements BotRunner {
  public constructor(
    private readonly orchestrator: PipelineOrchestrator,
    private readonly arbitrageScanner: ArbitrageScanner,
    private readonly startupGuard?: () => Promise<void>,
  ) {}

  public async runPollingLoop(options: PollingLoopOptions): Promise<void> {
    if (this.startupGuard !== undefined) {
      await this.startupGuard();
    }
    this.arbitrageScanner.start();
    try {
      await this.orchestrator.runLoop(options);
    } finally {
      this.arbitrageScanner.stop();
    }
  }
}

async function runDryRunReplay(config: RuntimeConfig, metrics: BotMetrics, logger: LoggerLike): Promise<void> {
  const chainConfig = getChainConfig(config.chain);
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createFailoverPublicClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    fallbackRpcUrls: config.fallbackRpcUrls,
  });
  const walletClient = createFailoverWalletClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    fallbackRpcUrls: config.fallbackRpcUrls,
    privateKey: config.privateKey,
  });
  const eventClient = config.wsRpcUrl === undefined
    ? publicClient
    : createChainWebSocketPublicClient({ chain: config.chain, wsRpcUrl: config.wsRpcUrl });
  const replayRegistry = createChainRegistry({
    chains: [{
      chain: config.chain,
      rpcUrl: config.rpcUrl,
      fallbackRpcUrls: config.fallbackRpcUrls,
      ...(config.wsRpcUrl === undefined ? {} : { wsRpcUrl: config.wsRpcUrl }),
      aaveSubgraphUrl: config.aaveSubgraphUrl,
      flashLoanProviders: ["aaveV3"],
    }],
  });
  const protocol = new ViemAaveV3Protocol(
    publicClient,
    chainConfig,
    createGraphClient(config.aaveSubgraphUrl),
    eventClient,
    50,
    replayRegistry,
  );
  const mockSequencerDown = parseBoolean(process.env.DRY_RUN_MOCK_SEQUENCER_DOWN, false);
  const sequencerUp = mockSequencerDown
    ? false
    : await isSequencerUp({
      publicClient,
      feed: config.sequencerUptimeFeed,
      logger,
    });
  if (!sequencerUp) {
    logger.warn("dry_run_replay_paused_sequencer_down", { chain: config.chain });
    return;
  }
  const latestBlock = await (publicClient as unknown as { getBlockNumber: () => Promise<bigint> }).getBlockNumber();
  const lookbackBlocks = parseMinNumber(process.env.DRY_RUN_REPLAY_BLOCKS, 50, 1, "DRY_RUN_REPLAY_BLOCKS");
  const fromBlock = latestBlock > BigInt(lookbackBlocks) ? latestBlock - BigInt(lookbackBlocks) : 0n;
  const reserveDataUpdated = parseAbiItem(
    "event ReserveDataUpdated(address indexed reserve,uint256 liquidityRate,uint256 stableBorrowRate,uint256 variableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex)",
  );
  const logs = await (publicClient as unknown as {
    getLogs: (args: Record<string, unknown>) => Promise<Array<{ args?: { reserve?: Address }; blockNumber?: bigint }>>;
  }).getLogs({
    address: chainConfig.aave.pool,
    event: reserveDataUpdated,
    fromBlock,
    toBlock: latestBlock,
  });
  const replayEvents = logs
    .map((log) => {
      const reserve = log.args?.reserve;
      if (reserve === undefined) {
        return undefined;
      }
      return {
        atMs: Number((log.blockNumber ?? latestBlock) * 1_000n),
        chain: config.chain,
        reserve,
      };
    })
    .filter((event): event is { atMs: number; chain: SupportedChain; reserve: Address } => event !== undefined);
  const snapshots = await new ReplayHarness({
    registry: replayRegistry,
    provider: new AaveSnapshotProvider(config.chain, protocol, replayRegistry),
    logger,
    metrics,
    events: replayEvents,
  }).run();
  const cache = new ReserveAwareBorrowerCache();
  for (const snapshot of snapshots) {
    cache.upsert(snapshot);
  }
  const replayCandidates = createReserveAwareCandidates(cache, config.chain);
  const candidates = replayCandidates.length > 0 ? replayCandidates : await protocol.getLiquidatablePositions();
  if (candidates.length === 0) {
    logger.warn("dry_run_replay_no_candidates", {
      chain: config.chain,
      fromBlock: fromBlock.toString(),
      toBlock: latestBlock.toString(),
    });
    return;
  }

  const usd = createAsset({ symbol: "USD", decimals: 8 });
  const registry = createChainRegistry({
    chains: [{
      chain: config.chain,
      rpcUrl: config.rpcUrl,
      fallbackRpcUrls: config.fallbackRpcUrls,
      ...(config.wsRpcUrl === undefined ? {} : { wsRpcUrl: config.wsRpcUrl }),
      aaveSubgraphUrl: config.aaveSubgraphUrl,
      flashLoanProviders: ["aaveV3"],
    }],
  });
  const router = new FlashLoanProviderRouter({
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
    providerFees: {},
  });
  const resolvedFlashLoanFeeBps = await readFlashLoanPremiumBps({
    publicClient,
    pool: chainConfig.aave.pool,
    fallbackBps: config.flashLoanFeeBps,
    logger,
  });
  router.setProviderFee(
    "aaveV3",
    createAssetAmount(usd, BigInt(Math.trunc(resolvedFlashLoanFeeBps * 1_000_000))),
  );
  const dryRunExecutor = new SafeTransactionExecutor({
    registry,
    router,
    nonceManager: new LocalNonceManager(),
    client: new ViemExecutionClient({ publicClient, walletClient }),
    logger,
    metrics,
    dryRunMode: true,
  });
  const priceOracleCache = config.priceFeedRegistry === undefined
    ? undefined
    : new PriceOracleCache({
      publicClient,
      chain: config.chain,
      feedRegistry: config.priceFeedRegistry,
      logger,
    });
  const gasPrice = await publicClient.getGasPrice();
  const gasCostUsd = priceOracleCache === undefined
    ? config.gasCostUsd
    : await (async () => {
      const nativeToken = nativeGasTokenForChain(config.chain);
      const prices = await priceOracleCache.batchGetUsdPrices([nativeToken]);
      const nativePriceRaw = prices[nativeToken] ?? 0n;
      if (nativePriceRaw <= 0n) {
        return config.gasCostUsd;
      }
      const gasCostWei = gasPrice * 500_000n;
      const gasCostUsdRaw = (gasCostWei * nativePriceRaw) / 1_000_000_000_000_000_000n;
      return Number(gasCostUsdRaw) / 1e8;
    })();
  let simulated = 0;
  for (const candidate of candidates.slice(0, 25)) {
    const request = buildLiquidationExecutionRequest(config.chain, candidate, {
      account: account.address,
      minProfitUsd: config.minProfitUsd,
      gasCostUsd,
      slippageBps: config.slippageBps,
      minimumMarginBps: config.minProfitMarginBps,
      flashFeeBps: resolvedFlashLoanFeeBps,
      slippageBufferFloorBps: config.flashLoanSlippageFloorBps,
      requireFlashLoanWrapper: true,
      ...(config.liquidationReceiverAddress === undefined ? {} : { flashLoanReceiverAddress: config.liquidationReceiverAddress }),
    });
    const result = await dryRunExecutor.execute(request);
    if (result.status === "simulated") {
      simulated += 1;
    }
  }
  if (simulated === 0) {
    throw new Error("Dry-run replay executed but no profitable flash-loan-wrapped liquidation simulations passed");
  }
  logger.info("dry_run_replay_complete", {
    chain: config.chain,
    candidates: candidates.length,
    simulated,
    replayEvents: replayEvents.length,
  });
}

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const logger = createLogger(config.logLevel);
  const metrics = createBotMetrics();
  const metricsServer = startMetricsServer(metrics, logger);
  if (process.argv.includes("--dry-run")) {
    try {
      await runDryRunReplay(config, metrics, logger);
    } finally {
      metricsServer.close();
    }
    return;
  }
  const safety = evaluateRuntimeDeploymentSafety(config);
  if (safety.status === "blocked") {
    logger.error("deployment_safety_gate_blocked", { reasons: safety.reasons });
    metricsServer.close();
    process.exitCode = 1;
    return;
  }
  const bot = buildBot(config, metrics);
  const controller = createShutdownController();
  try {
    await bot.runPollingLoop({ pollIntervalMs: config.pollIntervalMs, signal: controller.signal });
  } finally {
    metricsServer.close();
  }
}

function installProcessErrorHandlers(logger: LoggerLike): void {
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", { reason });
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", { error });
    process.exitCode = 1;
  });
}

function createShutdownController(): AbortController {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller;
}

function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function optionalEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function resolveAaveSubgraphUrlForChain(env: Env, chain: SupportedChain): string {
  const globalExplicit = optionalEnv(env, "AAVE_SUBGRAPH_URL");
  let url: string;
  if (globalExplicit !== undefined) {
    url = globalExplicit;
  } else {
    const baseOnly = chain === "base" ? optionalEnv(env, "BASE_AAVE_SUBGRAPH_URL") : undefined;
    if (baseOnly !== undefined) {
      url = baseOnly;
    } else {
      const apiKey = optionalEnv(env, "THE_GRAPH_API_KEY");
      if (apiKey !== undefined) {
        const id = aaveV3TheGraphSubgraphIds[chain];
        url = `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${id}`;
      } else {
        throw new Error(
          "Configure subgraph access: set AAVE_SUBGRAPH_URL, or THE_GRAPH_API_KEY, or (when using Base) BASE_AAVE_SUBGRAPH_URL. See README.",
        );
      }
    }
  }

  assertSubgraphBorrowerDiscoveryUrl(url);
  return url;
}

/** Stable string for dry-run hashing: single URL when one chain; sorted `chain:url` when several. */
function buildAaveSubgraphFingerprint(
  chains: readonly SupportedChain[],
  byChain: ReadonlyMap<SupportedChain, string>,
): string {
  if (chains.length === 1) {
    const only = chains[0];
    if (only === undefined) {
      throw new Error("At least one supported chain is required");
    }
    return byChain.get(only)!;
  }
  return [...chains]
    .map((c) => `${c}:${byChain.get(c)!}`)
    .sort()
    .join("|");
}

/** The liquidator pages borrowers via subgraph-style `positions` / `users` queries; AaveKit’s API is user-scoped only. */
function assertSubgraphBorrowerDiscoveryUrl(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`Aave subgraph URL is not valid: ${url}`);
  }

  if (hostname === "api.v3.aave.com") {
    throw new Error(
      "Subgraph URL points to the AaveKit GraphQL API (api.v3.aave.com), which does not support subgraph-style borrower paging (`positions`). " +
        "Use an Aave V3 indexing subgraph (AAVE_SUBGRAPH_URL, BASE_AAVE_SUBGRAPH_URL, or THE_GRAPH_API_KEY). See README.",
    );
  }
}

function parsePrivateKey(value: string): Hex {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string");
  }

  return value as Hex;
}

function parseAddress(value: string | undefined): Address | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error("Address env var must be a 20-byte hex address");
  }
  return value as Address;
}

function opportunityFeatures(opportunity: Opportunity): string[] {
  if (opportunity.kind === "liquidation") {
    return [
      "liquidation",
      `debt:${opportunity.candidate.debtAsset.toLowerCase()}`,
      `collateral:${opportunity.candidate.collateralAsset.toLowerCase()}`,
    ];
  }
  return [
    "arbitrage",
    `buy:${opportunity.candidate.buyDex.name}`,
    `sell:${opportunity.candidate.sellDex.name}`,
    `${opportunity.candidate.tokenIn.toLowerCase()}:${opportunity.candidate.tokenOut.toLowerCase()}`,
  ];
}

function estimateOpportunityProfitBps(opportunity: Opportunity): number {
  if (opportunity.kind === "liquidation") {
    const repayUsd = Math.max(1, opportunity.candidate.repayValueUsd);
    const grossUsd = repayUsd * (opportunity.candidate.liquidationBonusBps / 10_000);
    return Math.max(1, Math.round((grossUsd / repayUsd) * 10_000));
  }
  const base = opportunity.candidate.amountIn;
  if (base <= 0n) {
    return 1;
  }
  const raw = (opportunity.candidate.expectedAmountOut - base) * 10_000n / base;
  return Number(raw > 0n ? raw : 1n);
}

function parsePriceFeedRegistry(value: string | undefined): OracleFeedRegistry | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`PRICE_FEED_REGISTRY_JSON must be valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("PRICE_FEED_REGISTRY_JSON must be an object");
  }

  const output: Record<SupportedChain, Partial<Record<Address, { feed: Address; priceDecimals?: number }>>> = {
    optimism: {},
    arbitrum: {},
    base: {},
  };
  for (const chain of ["optimism", "arbitrum", "base"] as const) {
    const chainValue = (parsed as Record<string, unknown>)[chain];
    if (chainValue === undefined) {
      continue;
    }
    if (typeof chainValue !== "object" || chainValue === null) {
      throw new Error(`PRICE_FEED_REGISTRY_JSON.${chain} must be an object`);
    }
    for (const [token, config] of Object.entries(chainValue)) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(token)) {
        throw new Error(`Invalid token address in PRICE_FEED_REGISTRY_JSON.${chain}: ${token}`);
      }
      if (typeof config !== "object" || config === null) {
        throw new Error(`PRICE_FEED_REGISTRY_JSON.${chain}.${token} must be an object`);
      }
      const feed = (config as Record<string, unknown>).feed;
      if (typeof feed !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(feed)) {
        throw new Error(`PRICE_FEED_REGISTRY_JSON.${chain}.${token}.feed must be a 20-byte hex address`);
      }
      const priceDecimals = (config as Record<string, unknown>).priceDecimals;
      if (priceDecimals !== undefined && (!Number.isInteger(priceDecimals) || Number(priceDecimals) < 0)) {
        throw new Error(`PRICE_FEED_REGISTRY_JSON.${chain}.${token}.priceDecimals must be a non-negative integer`);
      }
      output[chain][token as Address] = {
        feed: feed as Address,
        ...(priceDecimals === undefined ? {} : { priceDecimals: Number(priceDecimals) }),
      };
    }
  }

  return output;
}

function defaultPriceFeedRegistry(): OracleFeedRegistry {
  return {
    optimism: {},
    arbitrum: {},
    base: {
      [canonicalBaseUsdc]: { feed: canonicalBaseUsdcUsdFeed, priceDecimals: 8 },
      [canonicalBaseWeth]: { feed: canonicalBaseEthUsdFeed, priceDecimals: 8 },
      [canonicalBaseCbBtc]: { feed: canonicalBaseCbBtcUsdFeed, priceDecimals: 8 },
    },
  };
}

function assertArbitragePriceFeedCoverage(config: RuntimeConfig): void {
  if (config.simulationMode || !config.usePipelineOrchestrator) {
    return;
  }
  const missing: string[] = [];
  for (const chain of config.chains) {
    const required = new Set<Address>();
    for (const pair of getMonitoredPairsForChain(chain)) {
      required.add(pair.tokenIn);
    }
    required.add(nativeGasTokenForChain(chain));
    const chainFeeds = config.priceFeedRegistry?.[chain] ?? {};
    for (const token of required) {
      if (chainFeeds[token] === undefined) {
        missing.push(`${chain}:${token}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Live arbitrage requires Chainlink feed coverage for tokenIn assets. Missing feeds: ${missing.join(", ")}`,
    );
  }
}

function assertPipelineFlashLiquidationReadiness(config: RuntimeConfig): void {
  if (!config.usePipelineOrchestrator || config.simulationMode) {
    return;
  }
  if (config.liquidationReceiverAddress === undefined) {
    throw new Error(
      "LIQUIDATION_RECEIVER_ADDRESS is required for live pipeline mode to enforce flash-loan-first liquidations",
    );
  }
}

export async function assertArbitrageOracleReadiness(
  config: RuntimeConfig,
  priceOracleCache: Pick<PriceOracleCache, "batchGetUsdPrices">,
): Promise<void> {
  if (config.simulationMode || !config.usePipelineOrchestrator) {
    return;
  }

  const failures: string[] = [];
  for (const chain of config.chains) {
    const required = new Set<Address>();
    for (const pair of getMonitoredPairsForChain(chain)) {
      required.add(pair.tokenIn);
    }
    required.add(nativeGasTokenForChain(chain));

    const prices = await priceOracleCache.batchGetUsdPrices([...required]);
    for (const token of required) {
      const price = prices[token] ?? 0n;
      if (price <= 0n) {
        failures.push(`${chain}:${token}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Live arbitrage startup rejected: missing/stale/non-positive oracle prices for ${failures.join(", ")}`,
    );
  }
}

function nativeGasTokenForChain(chain: SupportedChain): Address {
  if (chain === "arbitrum") {
    return "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
  }
  return "0x4200000000000000000000000000000000000006";
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseFlashLoanProviders(value: string | undefined): FlashLoanProviderId[] {
  if (value === undefined || value.trim() === "") {
    return ["aaveV3"];
  }
  const providers = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is FlashLoanProviderId => entry === "aaveV3" || entry === "balancer" || entry === "uniswapV3");
  return providers.length === 0 ? ["aaveV3"] : [...new Set(providers)];
}

function parsePrivateTxMode(value: string | undefined): PrivateTxMode {
  if (value === undefined || value.trim() === "") {
    return "auto";
  }
  if (value === "provider_private" || value === "sequencer_direct" || value === "auto") {
    return value;
  }
  throw new Error("PRIVATE_TX_MODE must be one of provider_private, sequencer_direct, auto");
}

function parseMinNumber(value: string | undefined, fallback: number, min: number, name: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be a number greater than or equal to ${min}`);
  }

  return parsed;
}

function parseEthThreshold(value: string | undefined): bigint {
  if (value === undefined || value.trim() === "") {
    return MIN_PROFIT_THRESHOLD_WEI;
  }

  return parseEther(value);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error("Boolean env vars must be true or false");
}

function parseRuntimeEnv(env: Env): Env {
  // Node's `process.env` is not a Zod "plain object" (see zod util.isPlainObject), so z.record() rejects it.
  const plainEnv = Object.assign(Object.create(null), env) as Env;
  const result = runtimeEnvSchema.safeParse(plainEnv);
  if (!result.success) {
    throw new Error(`Invalid runtime environment: ${result.error.message}`);
  }

  return result.data;
}

function parseDryRunValidation(
  env: Env,
  chains: readonly SupportedChain[],
  privateKey: Hex,
  subgraphFingerprint: string,
): DryRunValidationReceipt | undefined {
  const configHash = optionalEnv(env, "DRY_RUN_CONFIG_HASH");
  const validatedAtMs = optionalEnv(env, "DRY_RUN_VALIDATED_AT_MS");
  if (configHash === undefined || validatedAtMs === undefined) {
    return undefined;
  }

  return {
    success: parseBoolean(env.DRY_RUN_SUCCESS, false),
    validatedAtMs: Number(validatedAtMs),
    configHash,
    expectedConfigHash: runtimeConfigHash(env, chains, privateKey, subgraphFingerprint),
    chains: parseDryRunChains(env.DRY_RUN_CHAINS, chains),
    expectedChains: chains,
  };
}

function parseDryRunChains(
  value: string | undefined,
  fallback: readonly SupportedChain[],
): SupportedChain[] {
  if (value === undefined || value.trim() === "") {
    return [...fallback];
  }

  return value.split(",").map((entry) => parseSupportedChain(entry.trim()));
}

function runtimeConfigHash(
  env: Env,
  chains: readonly SupportedChain[],
  privateKey: Hex,
  subgraphFingerprint: string,
): string {
  const safetyRelevantConfig = {
    chains,
    rpcUrl: optionalEnv(env, "RPC_URL"),
    fallbackRpcUrls: parseList(env.FALLBACK_RPC_URLS),
    wsRpcUrl: optionalEnv(env, "WS_RPC_URL"),
    aaveSubgraphUrl: subgraphFingerprint,
    account: privateKeyToAccount(privateKey).address,
    pollIntervalMs: env.POLL_INTERVAL_MS ?? "400",
    candidateCooldownMs: env.CANDIDATE_COOLDOWN_MS ?? "30000",
    minProfitThresholdEth: env.MIN_PROFIT_THRESHOLD_ETH ?? "0.01",
    minProfitUsd: env.MIN_PROFIT_USD ?? "10",
    arbitrageMinProfitUsd: env.ARBITRAGE_MIN_PROFIT_USD ?? "0.15",
    gasCostUsd: env.GAS_COST_USD ?? "0",
    slippageBps: env.SLIPPAGE_BPS ?? "50",
    minProfitMarginBps: env.MIN_PROFIT_MARGIN_BPS ?? String(defaultProfitMarginBps),
    liquidationReceiverAddress: env.LIQUIDATION_RECEIVER_ADDRESS ?? "",
    priceFeedRegistryJson: env.PRICE_FEED_REGISTRY_JSON ?? "",
    simulationMode: env.SIMULATION_MODE ?? "true",
  };
  return JSON.stringify(safetyRelevantConfig);
}

function parseSupportedChains(env: Env): SupportedChain[] {
  const configuredChains = optionalEnv(env, "CHAINS");
  if (configuredChains === undefined) {
    return [parseSupportedChain(env.CHAIN)];
  }

  const chains = configuredChains
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseSupportedChain(entry));
  const uniqueChains = [...new Set(chains)];
  if (uniqueChains.length === 0) {
    throw new Error("CHAINS must include at least one supported chain");
  }

  return uniqueChains;
}

function firstSupportedChain(chains: readonly SupportedChain[]): SupportedChain {
  const chain = chains[0];
  if (chain === undefined) {
    throw new Error("At least one supported chain is required");
  }

  return chain;
}

function createGraphClient(url: string) {
  return {
    request: async <T>(query: string, variables: Record<string, number>): Promise<T> => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });

      const raw = await response.text();
      let payload: { data?: T; errors?: unknown };
      try {
        payload = JSON.parse(raw) as { data?: T; errors?: unknown };
      } catch {
        throw new Error(
          `Aave subgraph returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 500)}`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `Aave subgraph request failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 800)}`,
        );
      }

      if (payload.errors !== undefined) {
        throw new Error(`Aave subgraph GraphQL errors: ${JSON.stringify(payload.errors)}`);
      }

      if (payload.data === undefined) {
        throw new Error(`Aave subgraph response missing data: ${JSON.stringify(payload).slice(0, 800)}`);
      }

      return payload.data;
    },
  };
}

async function readFlashLoanPremiumBps(input: {
  readonly publicClient: {
    readContract(args: Record<string, unknown>): Promise<unknown>;
  };
  readonly pool: Address;
  readonly fallbackBps: number;
  readonly logger: LoggerLike;
}): Promise<number> {
  try {
    const raw = await input.publicClient.readContract({
      address: input.pool,
      abi: [{
        type: "function",
        name: "FLASHLOAN_PREMIUM_TOTAL",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint128" }],
      }],
      functionName: "FLASHLOAN_PREMIUM_TOTAL",
      args: [],
    });
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid flash-loan premium value: ${String(raw)}`);
    }
    input.logger.info("flash_loan_premium_loaded", { pool: input.pool, premiumBps: parsed });
    return parsed;
  } catch (error) {
    input.logger.warn("flash_loan_premium_fallback", {
      pool: input.pool,
      fallbackBps: input.fallbackBps,
      error: String(error),
    });
    return input.fallbackBps;
  }
}

type ResolvedAaveAddresses = {
  readonly pool?: Address;
  readonly poolAddressesProvider?: Address;
  readonly uiPoolDataProvider?: Address;
};

function withResolvedAave(config: ChainConfig, resolved: ResolvedAaveAddresses | undefined): ChainConfig {
  if (resolved === undefined) {
    return config;
  }
  return {
    ...config,
    aave: {
      ...config.aave,
      ...(resolved.pool === undefined ? {} : { pool: resolved.pool }),
      ...(resolved.poolAddressesProvider === undefined ? {} : { poolAddressesProvider: resolved.poolAddressesProvider }),
      ...(resolved.uiPoolDataProvider === undefined ? {} : { uiPoolDataProvider: resolved.uiPoolDataProvider }),
    },
  };
}

function resolvedAddressCachePath(): string {
  return resolve(process.cwd(), ".cache", "aave-addresses.json");
}

function loadResolvedAaveAddressCache(): Partial<Record<SupportedChain, ResolvedAaveAddresses>> {
  const path = resolvedAddressCachePath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, ResolvedAaveAddresses>;
    return {
      ...(parsed.optimism === undefined ? {} : { optimism: parsed.optimism }),
      ...(parsed.arbitrum === undefined ? {} : { arbitrum: parsed.arbitrum }),
      ...(parsed.base === undefined ? {} : { base: parsed.base }),
    };
  } catch {
    return {};
  }
}

async function resolveAndPersistAaveAddresses(input: {
  readonly chains: readonly SupportedChain[];
  readonly publicClient: { readContract(args: Record<string, unknown>): Promise<unknown> };
  readonly logger: LoggerLike;
}): Promise<Partial<Record<SupportedChain, ResolvedAaveAddresses>>> {
  const cache = loadResolvedAaveAddressCache();
  const resolved: Partial<Record<SupportedChain, ResolvedAaveAddresses>> = { ...cache };
  for (const chain of input.chains) {
    const defaults = getChainConfig(chain).aave;
    const provider = defaults.poolAddressesProvider;
    try {
      const pool = await input.publicClient.readContract({
        address: provider,
        abi: [{
          type: "function",
          name: "getPool",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "address" }],
        }],
        functionName: "getPool",
        args: [],
      }) as Address;
      resolved[chain] = {
        pool,
        poolAddressesProvider: provider,
        uiPoolDataProvider: defaults.uiPoolDataProvider,
      };
    } catch (error) {
      input.logger.warn("aave_address_resolution_failed", {
        chain,
        provider,
        error: String(error),
      });
      if (resolved[chain] === undefined) {
        resolved[chain] = {
          pool: defaults.pool,
          poolAddressesProvider: defaults.poolAddressesProvider,
          uiPoolDataProvider: defaults.uiPoolDataProvider,
        };
      }
    }
  }
  const path = resolvedAddressCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(resolved, null, 2), "utf8");
  return resolved;
}

async function isSequencerUp(input: {
  readonly publicClient: { readContract(args: Record<string, unknown>): Promise<unknown> };
  readonly feed: Address | undefined;
  readonly logger: LoggerLike;
}): Promise<boolean> {
  if (input.feed === undefined) {
    return true;
  }
  try {
    const round = await input.publicClient.readContract({
      address: input.feed,
      abi: [{
        type: "function",
        name: "latestRoundData",
        stateMutability: "view",
        inputs: [],
        outputs: [
          { type: "uint80" },
          { type: "int256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint80" },
        ],
      }],
      functionName: "latestRoundData",
      args: [],
    }) as readonly [bigint, bigint, bigint, bigint, bigint];
    const answer = round[1];
    const up = answer === 0n;
    if (!up) {
      input.logger.warn("sequencer_uptime_feed_down", { feed: input.feed, answer: answer.toString() });
    }
    return up;
  } catch (error) {
    input.logger.warn("sequencer_uptime_feed_check_failed", { feed: input.feed, error: String(error) });
    return true;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    createLogger("error").error("fatal_startup_error", { error });
    process.exitCode = 1;
  });
}
