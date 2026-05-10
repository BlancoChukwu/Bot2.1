import "dotenv/config";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  type SupportedChain,
} from "./config/chains";
import { createChainRegistry } from "./config/chainRegistry";
import { createLiquidationActions, LiquidationExecutor } from "./executors/liquidationExecutor";
import { buildArbitrageExecutionRequest } from "./executors/arbitrageExecutorAdapter";
import { buildLiquidationExecutionRequest } from "./executors/liquidationExecutionAdapter";
import { LocalNonceManager } from "./executors/nonceManager";
import { SafeTransactionExecutor } from "./executors/safeTransactionExecutor";
import { ViemExecutionClient } from "./executors/viemExecutionClient";
import { getDexesForChain, getMonitoredPairsForChain } from "./config/dexRegistry";
import { HealthFactorMonitor } from "./monitors/healthFactorMonitor";
import { ArbitrageOpportunityQueue } from "./monitors/arbitrageOpportunityQueue";
import { ArbitrageScanner } from "./monitors/arbitrageScanner";
import { PipelineDetectionAdapter } from "./orchestrator/pipelineDetectionAdapter";
import { PipelineDeadLetterQueue, PipelineOrchestrator } from "./orchestrator/pipelineOrchestrator";
import { buildLiquidationCallParams, ViemAaveV3Protocol } from "./protocols/aaveV3";
import { FlashLoanProviderRouter } from "./profitability/flashLoanProviderRouter";
import { ProfitabilityEngine } from "./profitability/profitabilityEngine";
import { MIN_PROFIT_THRESHOLD_WEI } from "./utils/evCalculator";
import { createAsset, createAssetAmount } from "./utils/typedAssetMath";
import { sendDailyPnlSummary, sendLiquidationAlert } from "./utils/telegramAlert";
import { DeploymentSafetyGate, type DeploymentGateResult, type DryRunValidationReceipt } from "./production/productionReadiness";
import { PnlTracker } from "./production/pnlTracker";
import type { Opportunity } from "./types/opportunity";

export interface RuntimeConfig {
  readonly chain: SupportedChain;
  readonly chains: readonly SupportedChain[];
  readonly rpcUrl: string;
  readonly fallbackRpcUrls: readonly string[];
  readonly wsRpcUrl: string | undefined;
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
  readonly simulationMode: boolean;
  readonly telegramBotToken: string | undefined;
  readonly telegramChatId: string | undefined;
  readonly pagerDutyRoutingKey: string | undefined;
  readonly dryRunValidation: DryRunValidationReceipt | undefined;
  readonly logLevel: string;
  readonly usePipelineOrchestrator: boolean;
  readonly arbitrageReceiverAddress: Address | undefined;
  readonly dailyPnlCsvPath: string | undefined;
}

export interface BotRunner {
  runPollingLoop(options: PollingLoopOptions): Promise<void>;
}

type Env = Record<string, string | undefined>;

const runtimeEnvSchema = z.record(z.string(), z.string().optional());
const minimumProfitMarginBps = 50;
const placeholderPrivateKey = "0x0000000000000000000000000000000000000000000000000000000000000000";

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

  return {
    chain,
    chains,
    rpcUrl,
    aaveSubgraphUrl,
    aaveSubgraphByChain,
    privateKey,
    fallbackRpcUrls: parseList(parsedEnv.FALLBACK_RPC_URLS),
    wsRpcUrl: optionalEnv(parsedEnv, "WS_RPC_URL"),
    pollIntervalMs: parseExactNumber(parsedEnv.POLL_INTERVAL_MS, 400, "POLL_INTERVAL_MS"),
    candidateCooldownMs: parseMinNumber(parsedEnv.CANDIDATE_COOLDOWN_MS, 30_000, 0, "CANDIDATE_COOLDOWN_MS"),
    minProfitWei: parseEthThreshold(parsedEnv.MIN_PROFIT_THRESHOLD_ETH),
    minProfitUsd: parseMinNumber(parsedEnv.MIN_PROFIT_USD, 10, 0, "MIN_PROFIT_USD"),
    gasCostUsd: parseMinNumber(parsedEnv.GAS_COST_USD, 0, 0, "GAS_COST_USD"),
    slippageBps: parseMinNumber(parsedEnv.SLIPPAGE_BPS, 50, 0, "SLIPPAGE_BPS"),
    minProfitMarginBps: parseMinNumber(
      parsedEnv.MIN_PROFIT_MARGIN_BPS,
      minimumProfitMarginBps,
      minimumProfitMarginBps,
      "MIN_PROFIT_MARGIN_BPS",
    ),
    simulationMode,
    telegramBotToken: optionalEnv(parsedEnv, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: optionalEnv(parsedEnv, "TELEGRAM_CHAT_ID"),
    pagerDutyRoutingKey: optionalEnv(parsedEnv, "PAGERDUTY_ROUTING_KEY"),
    dryRunValidation: parseDryRunValidation(parsedEnv, chains, privateKey, subgraphFingerprint),
    logLevel: parsedEnv.LOG_LEVEL ?? "info",
    usePipelineOrchestrator: parseBoolean(parsedEnv.USE_PIPELINE_ORCHESTRATOR, false),
    arbitrageReceiverAddress: parseAddress(optionalEnv(parsedEnv, "ARBITRAGE_RECEIVER_ADDRESS")),
    dailyPnlCsvPath: optionalEnv(parsedEnv, "DAILY_PNL_CSV_PATH"),
  };
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
  if (config.usePipelineOrchestrator) {
    return buildPipelineBot(config, metrics);
  }

  const chainConfig = getChainConfig(config.chain);
  const logger = createLogger(config.logLevel);
  const publicClient = createFailoverPublicClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    fallbackRpcUrls: config.fallbackRpcUrls,
  });
  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createFailoverWalletClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    fallbackRpcUrls: config.fallbackRpcUrls,
    privateKey: config.privateKey,
  });
  const eventClient = config.wsRpcUrl === undefined
    ? publicClient
    : createChainWebSocketPublicClient({ chain: config.chain, wsRpcUrl: config.wsRpcUrl });
  const protocol = new ViemAaveV3Protocol(
    publicClient,
    chainConfig,
    createGraphClient(config.aaveSubgraphUrl),
    eventClient,
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
  const protocol = new ViemAaveV3Protocol(
    publicClient,
    getChainConfig(config.chain),
    createGraphClient(config.aaveSubgraphUrl),
    eventClient,
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

  const registry = createChainRegistry({
    chains: config.chains.map((chainName) => ({
      chain: chainName,
      rpcUrl: config.rpcUrl,
      fallbackRpcUrls: config.fallbackRpcUrls,
      ...(config.wsRpcUrl === undefined ? {} : { wsRpcUrl: config.wsRpcUrl }),
      aaveSubgraphUrl: config.aaveSubgraphByChain.get(chainName)!,
      flashLoanProviders: ["aaveV3"],
    })),
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
    providerFees: {
      aaveV3: createAssetAmount(usd, 9_000_000n),
    },
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
  });
  const arbQueue = new ArbitrageOpportunityQueue();
  const detection = new PipelineDetectionAdapter({
    chain: config.chain,
    monitor,
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
    minProfitMarginBps: 120,
    opportunitySink: arbQueue,
  });
  const orchestrator = new PipelineOrchestrator({
    registry,
    detection,
    executor,
    deadLetters: new PipelineDeadLetterQueue(),
    logger,
    metrics,
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
    buildExecutionRequest: (candidate) =>
      buildLiquidationExecutionRequest(config.chain, candidate, {
        account: account.address,
        minProfitUsd: config.minProfitUsd,
        gasCostUsd: config.gasCostUsd,
        slippageBps: config.slippageBps,
        minimumMarginBps: config.minProfitMarginBps,
      }),
    buildExecutionRequestForOpportunity: (opportunity: Opportunity) => {
      if (opportunity.kind === "liquidation") {
        return buildLiquidationExecutionRequest(config.chain, opportunity.candidate, {
          account: account.address,
          minProfitUsd: config.minProfitUsd,
          gasCostUsd: config.gasCostUsd,
          slippageBps: config.slippageBps,
          minimumMarginBps: config.minProfitMarginBps,
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

  return new PipelineBotRunner(orchestrator, arbitrageScanner);
}

class PipelineBotRunner implements BotRunner {
  public constructor(
    private readonly orchestrator: PipelineOrchestrator,
    private readonly arbitrageScanner: ArbitrageScanner,
  ) {}

  public async runPollingLoop(options: PollingLoopOptions): Promise<void> {
    this.arbitrageScanner.start();
    try {
      await this.orchestrator.runLoop(options);
    } finally {
      this.arbitrageScanner.stop();
    }
  }
}

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const logger = createLogger(config.logLevel);
  const metrics = createBotMetrics();
  const metricsServer = startMetricsServer(metrics, logger);
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
    throw new Error("ARBITRAGE_RECEIVER_ADDRESS must be a 20-byte hex address");
  }
  return value as Address;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseExactNumber(value: string | undefined, expected: number, name: string): number {
  const parsed = value === undefined || value.trim() === "" ? expected : Number(value);
  if (parsed !== expected) {
    throw new Error(`${name} must be exactly ${expected}`);
  }

  return parsed;
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
    gasCostUsd: env.GAS_COST_USD ?? "0",
    slippageBps: env.SLIPPAGE_BPS ?? "50",
    minProfitMarginBps: env.MIN_PROFIT_MARGIN_BPS ?? "50",
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

if (require.main === module) {
  main().catch((error: unknown) => {
    createLogger("error").error("fatal_startup_error", { error });
    process.exitCode = 1;
  });
}
