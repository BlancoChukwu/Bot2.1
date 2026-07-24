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
import { computeLivePositionCoveragePct } from "./livePositionCoverage";
import { createBootstrapLogClients } from "./bootstrapRpcClients";
import { setBootstrapRuntimeStatus } from "../runtime/bootstrapRuntimeStatus";
import { pollLocalFeedFreshness } from "./localFeedFreshnessPoll";
import { reconcileAndSeedPosition } from "./positionOnChainReconcile";
import {
  reconcileFirstTouchWithRetry,
  type NeedsManualReconcileEntry,
} from "./firstTouchReconcile";
import { bootstrapAaveOracleGapFill, refreshGapFillPrices } from "../oracle/aaveOraclePrice";
import {
  collectEventReserveAssets,
  hydrateReserveDecimals,
} from "./reserveDecimals";
import { aavePoolAbi } from "../protocols/aaveV3";
import { parseEModeCategoryData, poolEmodeAbi } from "./aaveEmode";
import {
  decodeLiquidationThresholdBps,
  parseReserveConfigurationData,
} from "./reserveConfiguration";

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

function parseSequencerRound(result: unknown): { answer: bigint; startedAt: number } | undefined {
  if (Array.isArray(result)) {
    const answer = result[1];
    const startedAt = result[2];
    if (typeof answer !== "bigint") {
      return undefined;
    }
    return { answer, startedAt: Number(startedAt) };
  }
  if (typeof result === "object" && result !== null) {
    const record = result as { answer?: unknown; startedAt?: unknown };
    if (typeof record.answer !== "bigint") {
      return undefined;
    }
    return { answer: record.answer, startedAt: Number(record.startedAt) };
  }
  return undefined;
}

function parseLatestRoundData(result: unknown): { answer: bigint; updatedAt: number } | undefined {
  if (Array.isArray(result)) {
    const answer = result[1];
    const updatedAt = result[3];
    if (typeof answer !== "bigint") {
      return undefined;
    }
    return { answer, updatedAt: Number(updatedAt) };
  }
  if (typeof result === "object" && result !== null) {
    const record = result as { answer?: unknown; updatedAt?: unknown };
    if (typeof record.answer !== "bigint") {
      return undefined;
    }
    return { answer: record.answer, updatedAt: Number(record.updatedAt) };
  }
  return undefined;
}

function parseFeedDecimals(result: unknown): number | undefined {
  if (typeof result === "number") {
    return result;
  }
  if (typeof result === "bigint") {
    return Number(result);
  }
  return undefined;
}

async function readFeedPair(
  client: PublicClient,
  feed: Address,
): Promise<{ answer: bigint; updatedAt: number; decimals: number } | undefined> {
  try {
    const [lrdRaw, decRaw] = await Promise.all([
      client.readContract({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: "latestRoundData",
      }),
      client.readContract({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: "decimals",
      }),
    ]);
    const lrd = parseLatestRoundData(lrdRaw);
    const decimals = parseFeedDecimals(decRaw);
    if (lrd === undefined || decimals === undefined) {
      return undefined;
    }
    return { ...lrd, decimals };
  } catch {
    return undefined;
  }
}

function registerFeedIfWarm(input: {
  asset: Address;
  feed: Address;
  answer: bigint;
  updatedAt: number;
  decimals: number;
  blockTimestamp: number;
  model: LocalPositionModel;
  logger: LoggerLike;
  warmCriticalFeeds: Set<string>;
  bootstrappedPrices: Map<Address, { feed: Address; price: bigint; decimals: number }>;
}): void {
  const {
    asset: assetAddr,
    feed: feedAddr,
    answer,
    updatedAt,
    decimals,
    blockTimestamp,
    model,
    logger,
    warmCriticalFeeds,
    bootstrappedPrices,
  } = input;

  if (answer <= 0n) {
    logger.error("FEED_INVALID_PRICE", { asset: assetAddr, feed: feedAddr, answer: answer.toString() });
    return;
  }
  if (decimals > 18) {
    logger.error("FEED_DECIMAL_OVERFLOW", { asset: assetAddr, feed: feedAddr, decimals });
    return;
  }

  const normalizedPrice = answer * 10n ** BigInt(18 - decimals);
  const ageSec = blockTimestamp - updatedAt;
  const feedKey = feedAddr.toLowerCase();
  if (FEED_HEARTBEATS[feedKey] === undefined) {
    logger.warn("FEED_HEARTBEAT_UNKNOWN", { feed: feedAddr, asset: assetAddr, usingDefault: 3600 });
  }
  const heartbeat = FEED_HEARTBEATS[feedKey] ?? 3600;
  const staleThreshold = heartbeat * 1.5;
  const isStale = ageSec > staleThreshold;

  logger.info("feed_bootstrap", {
    asset: assetAddr,
    normalizedPrice: normalizedPrice.toString(),
    ageSec,
    heartbeat,
    status: isStale ? "STALE" : "WARM",
  });

  if (isStale) {
    logger.warn("FEED_STALE", { asset: assetAddr, feed: feedAddr, ageSec, staleThreshold });
    return;
  }

  model.registerBootstrapPrice(assetAddr, normalizedPrice, {
    answer,
    decimals,
    updatedAt,
    feedAddress: feedAddr,
    asset: assetAddr,
    source: "chainlink",
  });
  bootstrappedPrices.set(assetAddr, { feed: feedAddr, price: normalizedPrice, decimals });

  if (CRITICAL_FEEDS.some((f) => f.toLowerCase() === feedKey)) {
    warmCriticalFeeds.add(feedKey);
  }
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
  readonly onBlockObserved?: (blockNumber: bigint) => void;
  /** Test seam for first-touch reconcile backoff. */
  readonly sleepMs?: (ms: number) => Promise<void>;
}

export class EventPurityStack {
  private checkpoint: PositionCheckpointStore | undefined;
  private wsLayer: WsEventLayer | undefined;
  readonly model: LocalPositionModel;
  readonly confirmQueue: TieredConfirmQueue;
  readonly shadow: ShadowValidator;
  private indexRefreshInFlight = false;
  private aggregateRefreshInFlight = false;
  private flashblockTickCount = 0n;
  private bootstrapCoveragePct: number | undefined;
  private bootstrapStatus: PartialBootstrapCoverage | undefined;
  private pricesBootstrapped = false;
  private readonly needsManualReconcile = new Map<string, NeedsManualReconcileEntry>();

  public isPricesBootstrapped(): boolean {
    return this.pricesBootstrapped;
  }

  /** Dead-lettered first-touch accounts awaiting manual / later reconcile. */
  public getNeedsManualReconcile(): ReadonlyMap<string, NeedsManualReconcileEntry> {
    return this.needsManualReconcile;
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
      if (coverage.cacheHit) {
        await this.refreshReserveIndices();
      }
      await this.hydrateAllReserveDecimals();
    } else {
      this.config.logger.info("partial_bootstrap_skipped", {
        reason: "BOOTSTRAP_ENABLED=false",
      });
    }

    const bootstrapResult = await this.bootstrapOraclePrices();
    const gapFill = await bootstrapAaveOracleGapFill({
      client: this.config.executionClient,
      model: this.model,
      logger: this.config.logger,
    });
    if (gapFill.failed.length > 0) {
      this.config.logger.warn("oracle_gap_fill_partial", {
        warmed: gapFill.warmed,
        failed: gapFill.failed,
      });
    }
    await this.hydrateAllReserveDecimals();
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

  public getWsSubscriptionCount(): number {
    return this.wsLayer?.getActiveSubscriptionCount() ?? 0;
  }

  public async flushSurvivalState(blockNumber: bigint): Promise<void> {
    if (blockNumber > 0n) {
      await this.checkpoint?.saveLastProcessedBlock(blockNumber);
    }
  }

  public getBootstrapStatus(): PartialBootstrapCoverage | undefined {
    return this.bootstrapStatus;
  }

  public async refreshFeedFreshness(blockNumber: bigint): Promise<void> {
    if (blockNumber === 0n || !this.pricesBootstrapped) {
      return;
    }
    const chainFeeds = this.config.feedRegistry[this.config.chain] ?? {};
    const assets = Object.keys(chainFeeds).map((asset) => asset as Address);
    const changes = await pollLocalFeedFreshness({
      client: this.config.executionClient,
      chain: this.config.chain,
      model: this.model,
      feedRegistry: this.config.feedRegistry,
      assets,
      logger: this.config.logger,
    });
    await this.handleTierChanges(changes, blockNumber);
  }

  public async refreshGapFillPrices(): Promise<void> {
    if (!this.pricesBootstrapped) {
      this.config.logger.info("gap_fill_refresh_poll_result", {
        refreshed: 0,
        failedCount: 0,
        targetCount: 0,
        skipped: true,
        skipReason: "prices_not_bootstrapped",
      });
      return;
    }
    const result = await refreshGapFillPrices({
      client: this.config.executionClient,
      model: this.model,
      logger: this.config.logger,
    });
    this.config.logger.info("gap_fill_refresh_poll_result", {
      refreshed: result.refreshed,
      failedCount: result.failed.length,
      targetCount: result.targetCount,
      refreshedAssetCount: result.refreshedAssets.length,
    });
    if (result.failed.length > 0) {
      this.config.logger.warn("oracle_gap_fill_refresh_partial", {
        refreshed: result.refreshed,
        failedCount: result.failed.length,
        failed: result.failed,
      });
    }
    // Close the write-gap: prices/feedStates were updated by registerAavePrice, but tiers
    // only recompute on TierChange. Force HF recompute for positions touching refreshed assets.
    if (result.refreshedAssets.length > 0) {
      const changes = this.model.recomputeTiersForAssets(result.refreshedAssets);
      const head = await this.config.executionClient.getBlockNumber().catch(() => 0n);
      await this.handleTierChanges(changes, head);
    }
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
    if (event.meta.blockNumber > 0n) {
      this.config.onBlockObserved?.(event.meta.blockNumber);
    }
    if (event.kind === "chainlink_price") {
      const changes = this.model.applyPriceEvent(event);
      await this.handleTierChanges(changes, event.meta.blockNumber);
      return;
    }
    await hydrateReserveDecimals({
      client: this.config.executionClient,
      model: this.model,
      assets: collectEventReserveAssets(event),
      logger: this.config.logger,
    });
    const result = this.model.applyAaveEvent(event);
    if (result.firstTouchReconcile !== undefined) {
      await this.reconcileFirstTouch(result.firstTouchReconcile, event.meta.blockNumber);
    }
    await this.handleTierChanges(result.changes, event.meta.blockNumber);
  }

  private async reconcileFirstTouch(account: Address, blockNumber: bigint): Promise<void> {
    const chainConfig = getChainConfig(this.config.chain);
    const terminal = await reconcileFirstTouchWithRetry({
      chain: this.config.chain,
      account,
      blockNumber,
      logger: this.config.logger,
      needsManualReconcile: this.needsManualReconcile,
      removePartialPosition: () => {
        this.model.removePosition(account);
      },
      attemptReconcile: () => reconcileAndSeedPosition({
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
      }),
      ...(this.config.sleepMs === undefined ? {} : { sleepMs: this.config.sleepMs }),
    });

    if (terminal.status === "seeded") {
      await this.hydrateAllReserveDecimals();
      const change = this.model.tierChangeForAccount(account, true);
      if (change !== undefined && this.model.isPricesBootstrapped()) {
        await this.handleTierChanges([change], blockNumber);
      }
    }
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
      void this.shadow.maybeSample(change.account, blockNumber).catch((error) => {
        this.config.logger.warn("shadow_maybe_sample_failed", {
          account: change.account,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
    this.config.onBlockObserved?.(blockNumber);
    this.flashblockTickCount += 1n;
    if (this.flashblockTickCount % 1_800n === 0n) {
      this.shadow.logMetricsSnapshot("flashblock_interval");
      const positionCacheSize = this.model.size();
      const usersSeeded = this.bootstrapStatus?.usersSeeded ?? 0;
      const hardCap = this.config.purity.positionCacheHardCap;
      const livePositionCoveragePct = computeLivePositionCoveragePct(
        positionCacheSize,
        usersSeeded,
      );
      this.config.logger.info("event_purity_runtime_snapshot", {
        position_cache_size: positionCacheSize,
        // Historical bootstrap debtor ratio (withDebt/discovered) — frozen at boot.
        bootstrap_debtor_coverage_pct_at_boot: this.bootstrapCoveragePct,
        // Live gauge: recomputed every snapshot from cache size / usersSeeded.
        bootstrap_coverage_pct: livePositionCoveragePct,
        live_position_coverage_pct: livePositionCoveragePct,
        position_cache_hard_cap: hardCap,
        position_cache_at_hard_cap: positionCacheSize >= hardCap,
        bootstrapSource: this.bootstrapStatus?.discoverySource,
        usersSeeded,
        shadow_false_negative_total: this.shadow.getFalseNegativeTotal(),
        blockNumber: Number(blockNumber),
      });
      void this.refreshUrgentWatchAggregates(blockNumber).catch((error) => {
        this.config.logger.warn("aggregate_refresh_failed", { error: String(error) });
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
        const configuration = BigInt(data[0]);
        const configLt = decodeLiquidationThresholdBps(configuration);
        let liquidationThresholdBps = reserve.liquidationThresholdBps;
        if (configLt > 0n) {
          if (
            reserve.liquidationThresholdBps === 8500n
            && configLt !== 8500n
          ) {
            // Still on registerReserve fallback — adopt on-chain config bits.
            liquidationThresholdBps = configLt;
          } else if (configLt !== reserve.liquidationThresholdBps) {
            this.config.logger.warn("reserve_lt_config_mismatch", {
              asset: reserve.asset,
              pdpLt: reserve.liquidationThresholdBps.toString(),
              configBitsLt: configLt.toString(),
              preferred: "pdp",
            });
            // Prefer PDP-hydrated LT on mismatch.
            liquidationThresholdBps = reserve.liquidationThresholdBps;
          }
        }
        this.model.reserveConfig.set(reserve.asset.toLowerCase(), {
          ...reserve,
          liquidationThresholdBps,
          liquidityIndex: BigInt(data[1]),
          variableBorrowIndex: BigInt(data[3]),
          indexUpdatedAtBlock: 0n,
          reserveId: Number(data[7]),
        });
      } catch (error) {
        this.config.logger.warn("reserve_index_refresh_failed", {
          asset: reserve.asset,
          error: String(error),
        });
      }
    }
    await this.hydrateAllReserveDecimals();
    await this.hydrateKnownEModeCategories();
  }

  private async hydrateKnownEModeCategories(): Promise<void> {
    const categoryIds = new Set<number>();
    for (const position of this.model.positions.values()) {
      if (position.eModeCategoryId > 0) {
        categoryIds.add(position.eModeCategoryId);
      }
    }
    for (const categoryId of this.model.eModeCategories.keys()) {
      categoryIds.add(categoryId);
    }
    // Probe common Base liquid-eMode ids when none known yet (cheap view calls).
    if (categoryIds.size === 0) {
      for (let id = 1; id <= 8; id += 1) {
        categoryIds.add(id);
      }
    }
    for (const categoryId of categoryIds) {
      await this.hydrateEModeCategory(categoryId);
    }
  }

  private async hydrateEModeCategory(categoryId: number): Promise<void> {
    if (categoryId <= 0 || categoryId > 255) {
      return;
    }
    try {
      const [data, bitmap] = await Promise.all([
        this.config.executionClient.readContract({
          address: this.config.poolAddress,
          abi: poolEmodeAbi,
          functionName: "getEModeCategoryData",
          args: [categoryId],
        }),
        this.config.executionClient.readContract({
          address: this.config.poolAddress,
          abi: poolEmodeAbi,
          functionName: "getEModeCategoryCollateralBitmap",
          args: [categoryId],
        }),
      ]);
      const parsed = parseEModeCategoryData(categoryId, data, BigInt(bitmap));
      if (parsed === undefined || parsed.liquidationThresholdBps === 0n) {
        return;
      }
      this.model.setEModeCategory(parsed);
    } catch (error) {
      this.config.logger.warn("emode_category_hydrate_failed", {
        categoryId,
        error: String(error),
      });
    }
  }

  private async hydrateAllReserveDecimals(): Promise<void> {
    const result = await hydrateReserveDecimals({
      client: this.config.executionClient,
      model: this.model,
      logger: this.config.logger,
    });
    if (result.hydrated > 0 || result.failed.length > 0) {
      this.config.logger.info("reserve_decimals_hydrate", {
        hydrated: result.hydrated,
        failedCount: result.failed.length,
        failed: result.failed.slice(0, 20),
      });
    }
  }

  private async refreshUrgentWatchAggregates(blockNumber: bigint): Promise<void> {
    if (this.aggregateRefreshInFlight) {
      return;
    }
    const accounts = this.collectUrgentWatchAccounts();
    if (accounts.length === 0) {
      return;
    }
    this.aggregateRefreshInFlight = true;
    try {
      const batchSize = 250;
      for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const accountResults = await this.config.executionClient.multicall({
          contracts: batch.map((address) => ({
            address: this.config.poolAddress,
            abi: aavePoolAbi,
            functionName: "getUserAccountData",
            args: [address],
          })),
          allowFailure: true,
        });
        const emodeResults = await this.config.executionClient.multicall({
          contracts: batch.map((address) => ({
            address: this.config.poolAddress,
            abi: poolEmodeAbi,
            functionName: "getUserEMode",
            args: [address],
          })),
          allowFailure: true,
        });
        for (let j = 0; j < batch.length; j += 1) {
          const address = batch[j]!;
          const row = accountResults[j];
          if (row?.status !== "success") {
            continue;
          }
          const data = row.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
          const emode = emodeResults[j];
          const eModeCategoryId = emode?.status === "success" ? Number(emode.result) : 0;
          this.model.confirmOnChain(
            address,
            data[0],
            data[1],
            data[3],
            data[5],
            blockNumber,
            eModeCategoryId,
          );
          if (eModeCategoryId > 0 && !this.model.eModeCategories.has(eModeCategoryId)) {
            await this.hydrateEModeCategory(eModeCategoryId);
          }
        }
      }
      this.config.logger.info("aggregate_refresh_complete", {
        accounts: accounts.length,
        blockNumber: Number(blockNumber),
      });
    } finally {
      this.aggregateRefreshInFlight = false;
    }
  }

  private collectUrgentWatchAccounts(): Address[] {
    const out: Address[] = [];
    for (const position of this.model.positions.values()) {
      if (!position.isFullySeeded) {
        continue;
      }
      const tier = this.model.classifyTier(position.cachedHfWad);
      if (tier === "urgent" || tier === "watch" || tier === "liquidatable") {
        out.push(position.account);
      }
    }
    return out;
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
      const sequencerRound = parseSequencerRound(seqResult);
      if (sequencerRound === undefined) {
        throw new Error("sequencer_check_parse_failed");
      }
      const { answer, startedAt } = sequencerRound;
      blockTimestamp = Number(block.timestamp);
      const sequencerUp = answer === 0n;
      const graceElapsed = blockTimestamp - startedAt >= SEQUENCER_GRACE_PERIOD_SECONDS;
      const healthy = sequencerUp && graceElapsed;

      input.logger.info("sequencer_check", {
        attempt,
        answer: answer.toString(),
        startedAt,
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
  }) as readonly MulticallResult[];

  const warmCriticalFeeds = new Set<string>();
  const bootstrappedPrices = new Map<Address, { feed: Address; price: bigint; decimals: number }>();

  const lrdByKey = new Map<string, { answer: bigint; updatedAt: number }>();
  const decByKey = new Map<string, number>();

  for (let i = 0; i < feedIndex.length; i += 1) {
    const entry = feedIndex[i];
    const response = results[i];
    if (entry === undefined || response === undefined) {
      if (entry !== undefined) {
        input.logger.warn("oracle_multicall_subcall_missing", {
          asset: entry.asset,
          feed: entry.feed,
          type: entry.type,
          index: i,
        });
      }
      continue;
    }

    if (entry.type === "reserve") {
      if (response.status !== "success" || response.result === undefined) {
        input.logger.warn("RESERVE_CONFIG_FETCH_FAILED", { asset: entry.asset });
        input.model.setReserveLiquidationBonus(entry.asset, null);
        continue;
      }
      const parsed = parseReserveConfigurationData(response.result);
      if (parsed === undefined) {
        input.logger.warn("RESERVE_CONFIG_FETCH_FAILED", { asset: entry.asset, reason: "parse_failed" });
        input.model.setReserveLiquidationBonus(entry.asset, null);
        continue;
      }
      input.model.registerReserve(entry.asset, parsed.liquidationThresholdBps);
      input.model.setReserveLiquidationBonus(entry.asset, parsed.liquidationBonus);
      continue;
    }

    const key = `${entry.asset.toLowerCase()}:${entry.feed.toLowerCase()}`;
    if (response.status !== "success" || response.result === undefined) {
      input.logger.warn("oracle_multicall_subcall_failed", {
        asset: entry.asset,
        feed: entry.feed,
        type: entry.type,
        error: "error" in response ? String((response as { error?: unknown }).error) : undefined,
      });
      continue;
    }

    if (entry.type === "lrd") {
      const lrd = parseLatestRoundData(response.result);
      if (lrd !== undefined) {
        lrdByKey.set(key, lrd);
      }
    } else {
      const decimals = parseFeedDecimals(response.result);
      if (decimals !== undefined) {
        decByKey.set(key, decimals);
      }
    }
  }

  for (const [asset, feedConfig] of Object.entries(chainFeeds)) {
    if (feedConfig?.feed === undefined) {
      continue;
    }
    const assetAddr = asset as Address;
    const feedAddr = feedConfig.feed;
    const key = `${assetAddr.toLowerCase()}:${feedAddr.toLowerCase()}`;
    let lrd = lrdByKey.get(key);
    let decimalsRaw = decByKey.get(key);

    if (lrd === undefined || decimalsRaw === undefined) {
      const fallback = await readFeedPair(input.executionClient, feedAddr);
      if (fallback === undefined) {
        input.logger.warn("feed_bootstrap_skipped", {
          asset: assetAddr,
          feed: feedAddr,
          reason: "missing_multicall_pair",
        });
        continue;
      }
      input.logger.info("feed_bootstrap_read_fallback", { asset: assetAddr, feed: feedAddr });
      lrd = { answer: fallback.answer, updatedAt: fallback.updatedAt };
      decimalsRaw = fallback.decimals;
    }

    registerFeedIfWarm({
      asset: assetAddr,
      feed: feedAddr,
      answer: lrd.answer,
      updatedAt: lrd.updatedAt,
      decimals: decimalsRaw,
      blockTimestamp,
      model: input.model,
      logger: input.logger,
      warmCriticalFeeds,
      bootstrappedPrices,
    });
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
      });
      const directRound = parseLatestRoundData(directResult);
      if (directRound === undefined) {
        input.logger.warn("bootstrap_crosscheck_failed", { asset, reason: "parse_failed" });
        continue;
      }
      const directAnswer = directRound.answer;
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
