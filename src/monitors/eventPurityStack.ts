import type { Address, PublicClient } from "viem";
import { getChainConfig } from "../config/chains";
import { hfThresholdToWad, type EventPurityConfig } from "../config/eventPurityConfig";
import type { SupportedChain } from "../config/chains";
import type { BotMetrics, LoggerLike } from "../bot";
import type { OracleFeedRegistry } from "../utils/priceOracleCache";
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

  public constructor(private readonly config: EventPurityStackConfig) {
    const urgentHfWad = hfThresholdToWad(config.purity.localHfUrgent);
    const watchHfWad = hfThresholdToWad(config.purity.localHfWatch);
    this.model = new LocalPositionModel({
      purity: config.purity,
      urgentHfWad,
      watchHfWad,
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
      if (change !== undefined) {
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
}
