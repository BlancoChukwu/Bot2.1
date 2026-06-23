import type { Address, PublicClient } from "viem";
import { getChainConfig } from "../config/chains";
import { hfThresholdToWad, type EventPurityConfig } from "../config/eventPurityConfig";
import type { SupportedChain } from "../config/chains";
import type { BotMetrics, LoggerLike } from "../bot";
import {
  BASE_PROTOCOL_DATA_PROVIDER,
  BASE_SEQUENCER_UPTIME_FEED,
  BOOTSTRAP_MAX_RETRIES,
  BOOTSTRAP_RETRY_DELAY_MS,
  CRITICAL_FEEDS,
  FEED_HEARTBEATS,
  MULTICALL3_ADDRESS,
  protocolDataProviderAbi,
  SEQUENCER_GRACE_PERIOD_SECONDS,
} from "../config/oracleBootstrap";
import type { OracleFeedRegistry } from "../utils/priceOracleCache";
import { chainlinkAggregatorAbi } from "../utils/priceOracleCache";
import { LocalPositionModel } from "./localPositionModel";
import { PositionCheckpointStore } from "./positionCheckpointStore";
import { ShadowValidator } from "./shadowValidator";
import { TieredConfirmQueue, type ConfirmResult } from "./tieredConfirmQueue";
import { WsEventLayer } from "./wsEventLayer";
import type { ParsedIngestionEvent } from "./aaveEventParser";
import { runPartialBootstrapSweep, type PartialBootstrapCoverage } from "./partialBootstrapSweep";
import { createBootstrapLogClients } from "./bootstrapRpcClients";
import { setBootstrapRuntimeStatus } from "../runtime/bootstrapRuntimeStatus";
import { reconcileAndSeedPosition } from "./positionOnChainReconcile";

const WAD = 1_000_000_000_000_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type MulticallResult = {
  readonly status: "success" | "failure";
  readonly result?: unknown;
};

type FeedIndexEntry =
  | { readonly asset: Address; readonly feed: Address; readonly type: "lrd" | "dec" }
  | { readonly asset: Address; readonly feed: Address; readonly type: "reserve" };

export interface OracleBootstrapInput {
  readonly chain: SupportedChain;
  readonly executionClient: PublicClient;
  readonly feedRegistry: OracleFeedRegistry;
  readonly model: LocalPositionModel;
  readonly logger: LoggerLike;
  readonly sleepMs?: (ms: number) => Promise<void>;
}

export interface OracleBootstrapResult {
  readonly pricesBootstrapped: boolean;
  readonly sequencerHealthy: boolean;
  readonly warmCriticalFeeds: ReadonlySet<string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface EventPurityStackConfig {
  readonly chain: SupportedChain;
  readonly poolAddress: Address;
  readonly ingestionWsUrl: string;
  readonly executionClient: PublicClient;
  readonly feedRegistry: OracleFeedRegistry;
  readonly purity: EventPurityConfig;
  readonly reserveAllowlist?: readonly Address[];
  readonly redisUrl?: string;
  readonly logger: LoggerLike;
  readonly metrics?: BotMetrics;
  readonly bootstrapFromBlock?: bigint;
  readonly bootstrapSubgraphUrl?: string;
  readonly bootstrapLogRpcUrls?: readonly string[];
  readonly onLiquidatableCandidate?: (input: {
    readonly account: Address;
    readonly confirmed: ConfirmResult;
  }) => void | Promise<void>;
}

export class EventPurityStack {
  private checkpoint: PositionCheckpointStore | undefined;
  private wsLayer: WsEventLayer | undefined;
  readonly model: LocalPositionModel;
  readonly confirmQueue: TieredConfirmQueue;
  readonly shadow: ShadowValidator;
  private indexRefreshInFlight = false;
  private flashblockTickCount = 0n;
  private bootstrapCoveragePct: number | undefined;
  private bootstrapStatus: PartialBootstrapCoverage | undefined;
  private pricesBootstrapped = false;

  public isPricesBootstrapped(): boolean {
    return this.pricesBootstrapped;
  }

  public constructor(private readonly config: EventPurityStackConfig) {
    const urgentHfWad = hfThresholdToWad(config.purity.localHfUrgent);
    const watchHfWad = hfThresholdToWad(config.purity.localHfWatch);
    this.model = new LocalPositionModel({
      purity: config.purity,
      urgentHfWad,
      watchHfWad,
      logger: config.logger,
      ...(config.reserveAllowlist === undefined ? {} : { reserveAllowlist: config.reserveAllowlist }),
    });
    this.confirmQueue = new TieredConfirmQueue({
      client: config.executionClient,
      poolAddress: config.poolAddress,
      enableWatchTier: config.purity.enableWatchTierConfirm,
    });
    this.shadow = new ShadowValidator({
      client: config.executionClient,
      poolAddress: config.poolAddress,
      model: this.model,
      purity: config.purity,
      logger: config.logger,
    });
    for (const [asset, feed] of Object.entries(config.feedRegistry[config.chain] ?? {})) {
      if (feed?.feed !== undefined) {
        this.model.registerPriceFeed(feed.feed, asset as Address, 1n);
      }
    }
  }

  public async start(): Promise<void> {
    this.checkpoint = await PositionCheckpointStore.create({
      chain: this.config.chain,
      logger: this.config.logger,
      ...(this.config.redisUrl === undefined ? {} : { redisUrl: this.config.redisUrl }),
    });

    if (this.config.purity.bootstrapEnabled) {
      const logClients = this.config.bootstrapLogRpcUrls === undefined
        ? undefined
        : createBootstrapLogClients(this.config.chain, this.config.bootstrapLogRpcUrls);
      const coverage = await runPartialBootstrapSweep({
        chain: this.config.chain,
        client: this.config.executionClient,
        model: this.model,
        logger: this.config.logger,
        lookbackDays: this.config.purity.bootstrapLookbackDays,
        poolAddress: this.config.poolAddress,
        cacheEnabled: this.config.purity.bootstrapCacheEnabled,
        cacheTtlHours: this.config.purity.bootstrapCacheTtlHours,
        ...(logClients === undefined ? {} : { logDiscoveryClients: logClients }),
        ...(this.config.bootstrapSubgraphUrl === undefined
          ? {}
          : { subgraphUrl: this.config.bootstrapSubgraphUrl }),
        ...(this.config.reserveAllowlist === undefined
          ? {}
          : { reserveAllowlist: this.config.reserveAllowlist }),
      });
      this.bootstrapCoveragePct = coverage.estimatedDebtorCoveragePct;
      this.bootstrapStatus = coverage;
      this.publishBootstrapStatus(coverage);
    } else {
      this.config.logger.info("partial_bootstrap_skipped", {
        reason: "BOOTSTRAP_ENABLED=false",
      });
    }

    const bootstrapResult = await this.bootstrapOraclePrices();
    this.pricesBootstrapped = bootstrapResult.pricesBootstrapped;

    const head = await this.config.executionClient.getBlockNumber();
    const lookbackBlocks = BigInt(this.config.purity.bootstrapLookbackDays) * 43_200n;
    const bootstrapFromBlock = head > lookbackBlocks ? head - lookbackBlocks : 0n;

    this.wsLayer = new WsEventLayer({
      chain: this.config.chain,
      poolAddress: this.config.poolAddress,
      ingestionWsUrl: this.config.ingestionWsUrl,
      executionClient: this.config.executionClient,
      feedRegistry: this.config.feedRegistry,
      checkpoint: this.checkpoint,
      logger: this.config.logger,
      ...(this.config.metrics === undefined ? {} : { metrics: this.config.metrics }),
      bootstrapFromBlock: this.config.bootstrapFromBlock ?? bootstrapFromBlock,
      onEvent: (event) => this.handleEvent(event),
      onFlashblockTick: (blockNumber) => this.handleFlashblockTick(blockNumber),
    });
    await this.wsLayer.start();
  }

  public async stop(): Promise<void> {
    this.wsLayer?.stop();
    await this.checkpoint?.close();
  }

  public getBootstrapStatus(): PartialBootstrapCoverage | undefined {
    return this.bootstrapStatus;
  }

  private publishBootstrapStatus(coverage: PartialBootstrapCoverage): void {
    setBootstrapRuntimeStatus({
      bootstrapSource: coverage.discoverySource,
      usersSeeded: coverage.usersSeeded,
      positionCacheSize: coverage.positionCacheSize,
      bootstrapCacheHit: coverage.cacheHit,
    });
    this.config.metrics?.setBootstrapStatus(
      this.config.chain,
      coverage.discoverySource,
      coverage.usersSeeded,
      coverage.positionCacheSize,
    );
    this.config.logger.info("event_purity_bootstrap_status", {
      bootstrapSource: coverage.discoverySource,
      usersSeeded: coverage.usersSeeded,
      positionCacheSize: coverage.positionCacheSize,
      accountsAllowlistMatched: coverage.accountsAllowlistMatched,
      cacheHit: coverage.cacheHit,
      discoverySource: coverage.discoverySource,
    });
  }

  private async handleEvent(event: ParsedIngestionEvent): Promise<void> {
    if (event.kind === "chainlink_price") {
      const changes = this.model.applyPriceEvent(event);
      await this.handleTierChanges(changes, event.meta.blockNumber);
      return;
    }
    const result = this.model.applyAaveEvent(event);
    if (result.firstTouchReconcile !== undefined) {
      await this.reconcileFirstTouch(result.firstTouchReconcile, event.meta.blockNumber);
    }
    await this.handleTierChanges(result.changes, event.meta.blockNumber);
  }

  private async reconcileFirstTouch(account: Address, blockNumber: bigint): Promise<void> {
    const chainConfig = getChainConfig(this.config.chain);
    const seeded = await reconcileAndSeedPosition({
      client: this.config.executionClient,
      model: this.model,
      poolAddress: this.config.poolAddress,
      poolAddressesProvider: chainConfig.aave.poolAddressesProvider,
      uiPoolDataProvider: chainConfig.aave.uiPoolDataProvider,
      account,
      blockNumber,
      logger: this.config.logger,
      ...(this.config.reserveAllowlist === undefined
        ? {}
        : { reserveAllowlist: this.config.reserveAllowlist }),
    });
    if (seeded) {
      this.config.logger.info("position_first_touch_reconciled", {
        chain: this.config.chain,
        account,
        blockNumber: Number(blockNumber),
      });
      const change = this.model.tierChangeForAccount(account, true);
      if (change !== undefined && this.model.isPricesBootstrapped()) {
        await this.handleTierChanges([change], blockNumber);
      }
      return;
    }
    this.config.logger.info("position_first_touch_reconcile_skipped", {
      chain: this.config.chain,
      account,
      blockNumber: Number(blockNumber),
    });
  }

  private async handleTierChanges(
    changes: readonly {
      readonly account: Address;
      readonly tier: string;
      readonly localHfWad: bigint;
      readonly isNew: boolean;
      readonly isFullySeeded: boolean;
    }[],
    blockNumber: bigint,
  ): Promise<void> {
    if (!this.model.isPricesBootstrapped()) {
      return;
    }
    for (const change of changes) {
      if (!change.isFullySeeded) {
        continue;
      }
      if (change.account.toLowerCase() === ZERO_ADDRESS) {
        continue;
      }
      if (change.isNew && change.tier !== "healthy") {
        this.confirmQueue.enqueueUrgent(change.account);
      } else if (change.tier === "urgent") {
        this.confirmQueue.enqueueUrgent(change.account);
      } else if (change.tier === "watch") {
        this.confirmQueue.enqueueWatch(change.account);
      }
      void this.shadow.maybeSample(change.account, change.localHfWad, blockNumber);
    }
    const confirmed = await this.confirmQueue.flushUrgent();
    for (const row of confirmed) {
      this.model.confirmOnChain(
        row.address,
        row.totalCollateralBase,
        row.totalDebtBase,
        row.liquidationThreshold,
        row.healthFactor,
        blockNumber,
        row.eModeCategoryId,
      );
      if (row.healthFactor < WAD && this.model.isFullySeeded(row.address)) {
        this.config.logger.info("event_purity_liquidatable_candidate", {
          chain: this.config.chain,
          account: row.address,
          healthFactor: Number(row.healthFactor) / 1e18,
          liveTxEnabled: this.config.purity.enableLiveTx,
        });
        await this.config.onLiquidatableCandidate?.({ account: row.address, confirmed: row });
      }
    }
  }

  private async handleFlashblockTick(blockNumber: bigint): Promise<void> {
    this.flashblockTickCount += 1n;
    if (this.flashblockTickCount % 1_800n === 0n) {
      this.shadow.logMetricsSnapshot("flashblock_interval");
      this.config.logger.info("event_purity_runtime_snapshot", {
        position_cache_size: this.model.size(),
        bootstrap_coverage_pct: this.bootstrapCoveragePct,
        bootstrapSource: this.bootstrapStatus?.discoverySource,
        usersSeeded: this.bootstrapStatus?.usersSeeded,
        shadow_false_negative_total: this.shadow.getFalseNegativeTotal(),
        blockNumber: Number(blockNumber),
      });
    }

    const shouldRefresh = this.model.onFlashblockTick(blockNumber);
    if (!shouldRefresh || this.indexRefreshInFlight) {
      return;
    }
    this.indexRefreshInFlight = true;
    try {
      await this.refreshReserveIndices();
      await this.checkpoint?.saveLastProcessedBlock(blockNumber);
    } finally {
      this.indexRefreshInFlight = false;
    }
  }

  private async refreshReserveIndices(): Promise<void> {
    for (const reserve of this.model.reserveConfig.values()) {
      try {
        const data = await this.config.executionClient.readContract({
          address: this.config.poolAddress,
          abi: [
            {
              type: "function",
              name: "getReserveData",
              stateMutability: "view",
              inputs: [{ name: "asset", type: "address" }],
              outputs: [
                { name: "configuration", type: "uint256" },
                { name: "liquidityIndex", type: "uint128" },
                { name: "currentLiquidityRate", type: "uint128" },
                { name: "variableBorrowIndex", type: "uint128" },
                { name: "currentVariableBorrowRate", type: "uint128" },
                { name: "currentStableBorrowRate", type: "uint128" },
                { name: "lastUpdateTimestamp", type: "uint40" },
                { name: "id", type: "uint16" },
                { name: "aTokenAddress", type: "address" },
                { name: "stableDebtTokenAddress", type: "address" },
                { name: "variableDebtTokenAddress", type: "address" },
                { name: "interestRateStrategyAddress", type: "address" },
                { name: "accruedToTreasury", type: "uint128" },
                { name: "unbacked", type: "uint128" },
                { name: "isolationModeTotalDebt", type: "uint128" },
              ],
            },
          ],
          functionName: "getReserveData",
          args: [reserve.asset],
        });
        this.model.reserveConfig.set(reserve.asset.toLowerCase(), {
          ...reserve,
          liquidityIndex: BigInt(data[1]),
          variableBorrowIndex: BigInt(data[3]),
          indexUpdatedAtBlock: 0n,
        });
      } catch (error) {
        this.config.logger.warn("reserve_index_refresh_failed", {
          asset: reserve.asset,
          error: String(error),
        });
      }
    }
  }

  private async bootstrapOraclePrices(): Promise<OracleBootstrapResult> {
    return runOraclePriceBootstrap({
      chain: this.config.chain,
      executionClient: this.config.executionClient,
      feedRegistry: this.config.feedRegistry,
      model: this.model,
      logger: this.config.logger,
    });
  }
}

/**
 * Oracle price bootstrap: sequencer health, then a single Multicall3 eth_call for all
 * Chainlink feeds and reserve liquidation bonuses (CUPS budget vs N sequential calls).
 */
export async function runOraclePriceBootstrap(
  input: OracleBootstrapInput,
): Promise<OracleBootstrapResult> {
  const sleepFn = input.sleepMs ?? sleep;
  let sequencerHealthy = false;
  let blockTimestamp = 0;

  for (let attempt = 1; attempt <= BOOTSTRAP_MAX_RETRIES; attempt += 1) {
    try {
      const [seqResult, block] = await Promise.all([
        input.executionClient.readContract({
          address: BASE_SEQUENCER_UPTIME_FEED,
          abi: chainlinkAggregatorAbi,
          functionName: "latestRoundData",
        }),
        input.executionClient.getBlock({ blockTag: "latest" }),
      ]);
      const [, answer, startedAt] = seqResult as readonly [bigint, bigint, bigint, bigint, bigint];
      blockTimestamp = Number(block.timestamp);
      const sequencerUp = answer === 0n;
      const graceElapsed = blockTimestamp - Number(startedAt) >= SEQUENCER_GRACE_PERIOD_SECONDS;
      const healthy = sequencerUp && graceElapsed;

      input.logger.info("sequencer_check", {
        attempt,
        answer: answer.toString(),
        startedAt: Number(startedAt),
        blockTimestamp,
        healthy,
      });

      if (healthy) {
        sequencerHealthy = true;
        break;
      }

      if (attempt === BOOTSTRAP_MAX_RETRIES) {
        throw new Error("SEQUENCER_DOWN_OR_IN_GRACE_PERIOD: bootstrap aborted after 5 attempts");
      }
      await sleepFn(BOOTSTRAP_RETRY_DELAY_MS);
    } catch (error) {
      if (attempt === BOOTSTRAP_MAX_RETRIES) {
        throw error instanceof Error
          ? error
          : new Error("SEQUENCER_DOWN_OR_IN_GRACE_PERIOD: bootstrap aborted after 5 attempts");
      }
      input.logger.warn("sequencer_check_failed", { attempt, error: String(error) });
      await sleepFn(BOOTSTRAP_RETRY_DELAY_MS);
    }
  }

  const chainFeeds = input.feedRegistry[input.chain] ?? {};
  const contracts: {
    address: Address;
    abi: typeof chainlinkAggregatorAbi | typeof protocolDataProviderAbi;
    functionName: string;
    args?: readonly [Address];
  }[] = [];
  const feedIndex: FeedIndexEntry[] = [];

  for (const [asset, feedConfig] of Object.entries(chainFeeds)) {
    if (feedConfig?.feed === undefined) {
      continue;
    }
    const assetAddr = asset as Address;
    const feedAddr = feedConfig.feed;
    contracts.push({
      address: feedAddr,
      abi: chainlinkAggregatorAbi,
      functionName: "latestRoundData",
    });
    feedIndex.push({ asset: assetAddr, feed: feedAddr, type: "lrd" });
    contracts.push({
      address: feedAddr,
      abi: chainlinkAggregatorAbi,
      functionName: "decimals",
    });
    feedIndex.push({ asset: assetAddr, feed: feedAddr, type: "dec" });
  }

  for (const asset of Object.keys(chainFeeds)) {
    const assetAddr = asset as Address;
    contracts.push({
      address: BASE_PROTOCOL_DATA_PROVIDER,
      abi: protocolDataProviderAbi,
      functionName: "getReserveConfigurationData",
      args: [assetAddr],
    });
    feedIndex.push({
      asset: assetAddr,
      feed: BASE_PROTOCOL_DATA_PROVIDER,
      type: "reserve",
    });
  }

  const results = await input.executionClient.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: MULTICALL3_ADDRESS,
  }) as readonly MulticallResult[];

  const warmCriticalFeeds = new Set<string>();
  const bootstrappedPrices = new Map<Address, { feed: Address; price: bigint; decimals: number }>();

  const lrdByKey = new Map<string, { answer: bigint; updatedAt: number }>();
  const decByKey = new Map<string, number>();

  for (let i = 0; i < feedIndex.length; i += 1) {
    const entry = feedIndex[i];
    const response = results[i];
    if (entry === undefined || response === undefined) {
      continue;
    }

    if (entry.type === "reserve") {
      if (response.status !== "success" || response.result === undefined) {
        input.logger.warn("RESERVE_CONFIG_FETCH_FAILED", { asset: entry.asset });
        input.model.setReserveLiquidationBonus(entry.asset, null);
        continue;
      }
      const {
        liquidationBonus,
      } = response.result as {
        liquidationBonus: bigint;
      };
      input.model.registerReserve(entry.asset);
      input.model.setReserveLiquidationBonus(entry.asset, liquidationBonus);
      continue;
    }

    const key = `${entry.asset.toLowerCase()}:${entry.feed.toLowerCase()}`;
    if (response.status !== "success" || response.result === undefined) {
      input.logger.warn("oracle_multicall_subcall_failed", {
        asset: entry.asset,
        feed: entry.feed,
        type: entry.type,
      });
      continue;
    }

    if (entry.type === "lrd") {
      const [, answer, , updatedAt] = response.result as readonly [bigint, bigint, bigint, bigint, bigint];
      lrdByKey.set(key, { answer, updatedAt: Number(updatedAt) });
    } else {
      decByKey.set(key, Number(response.result as number | bigint));
    }
  }

  for (const [asset, feedConfig] of Object.entries(chainFeeds)) {
    if (feedConfig?.feed === undefined) {
      continue;
    }
    const assetAddr = asset as Address;
    const feedAddr = feedConfig.feed;
    const key = `${assetAddr.toLowerCase()}:${feedAddr.toLowerCase()}`;
    const lrd = lrdByKey.get(key);
    const decimalsRaw = decByKey.get(key);

    if (lrd === undefined || decimalsRaw === undefined) {
      input.logger.warn("feed_bootstrap_skipped", { asset: assetAddr, feed: feedAddr, reason: "missing_multicall_pair" });
      continue;
    }

    const { answer, updatedAt } = lrd;
    const decimals = decimalsRaw;

    if (answer <= 0n) {
      input.logger.error("FEED_INVALID_PRICE", { asset: assetAddr, feed: feedAddr, answer: answer.toString() });
      continue;
    }
    if (decimals > 18) {
      input.logger.error("FEED_DECIMAL_OVERFLOW", { asset: assetAddr, feed: feedAddr, decimals });
      continue;
    }

    const normalizedPrice = answer * 10n ** BigInt(18 - decimals);
    const ageSec = blockTimestamp - updatedAt;
    const feedKey = feedAddr.toLowerCase();
    if (FEED_HEARTBEATS[feedKey] === undefined) {
      input.logger.warn("FEED_HEARTBEAT_UNKNOWN", { feed: feedAddr, asset: assetAddr, usingDefault: 3600 });
    }
    const heartbeat = FEED_HEARTBEATS[feedKey] ?? 3600;
    const staleThreshold = heartbeat * 1.5;
    const isStale = ageSec > staleThreshold;

    input.logger.info("feed_bootstrap", {
      asset: assetAddr,
      normalizedPrice: normalizedPrice.toString(),
      ageSec,
      heartbeat,
      status: isStale ? "STALE" : "WARM",
    });

    if (isStale) {
      input.logger.warn("FEED_STALE", { asset: assetAddr, feed: feedAddr, ageSec, staleThreshold });
      continue;
    }

    input.model.registerBootstrapPrice(assetAddr, normalizedPrice, {
      answer,
      decimals,
      updatedAt,
      feedAddress: feedAddr,
      asset: assetAddr,
    });
    bootstrappedPrices.set(assetAddr, { feed: feedAddr, price: normalizedPrice, decimals });

    if (CRITICAL_FEEDS.some((f) => f.toLowerCase() === feedKey)) {
      warmCriticalFeeds.add(feedKey);
    }
  }

  const criticalFeedsOk = CRITICAL_FEEDS.every((f) => warmCriticalFeeds.has(f.toLowerCase()));
  let pricesBootstrapped = false;

  if (sequencerHealthy && criticalFeedsOk) {
    input.model.markPricesBootstrapped();
    pricesBootstrapped = true;
    input.logger.info("oracle_bootstrap_complete", {
      warmedFeeds: warmCriticalFeeds.size,
      criticalFeedsOk: true,
      pricesBootstrapped: true,
    });
  } else {
    input.logger.error("oracle_bootstrap_incomplete", {
      missingCritical: CRITICAL_FEEDS.filter((f) => !warmCriticalFeeds.has(f.toLowerCase())),
      sequencerHealthy,
      criticalFeedsOk,
    });
  }

  if (pricesBootstrapped) {
    await runBootstrapDiagnosticCrossCheck(input, bootstrappedPrices);
  }

  return { pricesBootstrapped, sequencerHealthy, warmCriticalFeeds };
}

async function runBootstrapDiagnosticCrossCheck(
  input: OracleBootstrapInput,
  bootstrappedPrices: ReadonlyMap<Address, { feed: Address; price: bigint; decimals: number }>,
): Promise<void> {
  for (const [asset, row] of bootstrappedPrices) {
    if (!CRITICAL_FEEDS.some((f) => f.toLowerCase() === row.feed.toLowerCase())) {
      continue;
    }
    try {
      const directResult = await input.executionClient.readContract({
        address: row.feed,
        abi: chainlinkAggregatorAbi,
        functionName: "latestRoundData",
      }) as readonly [bigint, bigint, bigint, bigint, bigint];
      const directAnswer = directResult[1];
      const directNormalized = directAnswer * 10n ** BigInt(18 - row.decimals);
      const expectedPrice = row.price;
      const delta = expectedPrice > directNormalized
        ? expectedPrice - directNormalized
        : directNormalized - expectedPrice;
      const pct = directNormalized === 0n ? 0 : Number((delta * 10000n) / directNormalized);
      if (pct > 200) {
        input.logger.error("BOOTSTRAP_PRICE_MISMATCH", {
          asset,
          bootstrapped: expectedPrice.toString(),
          direct: directNormalized.toString(),
          bps: pct,
        });
      } else {
        input.logger.info("bootstrap_crosscheck_ok", { asset, bps: pct });
      }
    } catch (error) {
      input.logger.warn("bootstrap_crosscheck_failed", { asset, error: String(error) });
    }
  }
}
