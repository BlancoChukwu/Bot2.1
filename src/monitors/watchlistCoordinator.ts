import type { Address, PublicClient } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { AaveV3Protocol } from "../protocols/aaveV3";
import { BlockCursor, createBlockCursor } from "../utils/blockCursor";
import { AaveSnapshotProvider } from "./aaveSnapshotProvider";
import type { BorrowerSnapshotProvider } from "./hybridDetectionPipeline";
import { BoundedWatchlist } from "./boundedWatchlist";
import { EventDrivenWatchlist } from "./eventDrivenWatchlist";
import {
  filterAddressesForSweep,
  sweepHealthFactors,
} from "./healthFactorSweep";
import type { BorrowerSnapshot } from "./reserveAwareBorrowerCache";
import { StalenessGuard } from "./stalenessGuard";

export interface WatchlistCoordinatorConfig {
  readonly chain: SupportedChain;
  readonly protocol: AaveV3Protocol;
  readonly registry: ChainRegistry;
  readonly readClient: PublicClient;
  readonly wsClient?: PublicClient;
  readonly poolAddress: Address;
  readonly logger: LoggerLike;
  readonly metrics?: BotMetrics;
  readonly minDebtBase: bigint;
  readonly multicallBatchSize?: number;
  readonly lowTierEveryBlocks?: bigint;
  readonly redisUrl?: string;
  readonly coldStartLookbackBlocks?: bigint;
}

export class WatchlistCoordinator implements BorrowerSnapshotProvider {
  public readonly stalenessGuard = new StalenessGuard();
  public readonly watchlist = new BoundedWatchlist();
  private readonly snapshotProvider: AaveSnapshotProvider;
  private cursor: BlockCursor | undefined;
  private eventWatchlist: EventDrivenWatchlist | undefined;
  private started = false;
  private sweepInFlight = false;

  public constructor(private readonly config: WatchlistCoordinatorConfig) {
    this.snapshotProvider = new AaveSnapshotProvider(
      config.chain,
      config.protocol,
      config.registry,
    );
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.cursor = await createBlockCursor(this.config.chain, {
      ...(this.config.redisUrl === undefined ? {} : { redisUrl: this.config.redisUrl }),
      logger: this.config.logger,
    });
    this.eventWatchlist = new EventDrivenWatchlist({
      chain: this.config.chain,
      poolAddress: this.config.poolAddress,
      readClient: this.config.readClient,
      ...(this.config.wsClient === undefined ? {} : { wsClient: this.config.wsClient as PublicClient }),
      watchlist: this.watchlist,
      cursor: this.cursor,
      logger: this.config.logger,
      ...(this.config.metrics === undefined ? {} : { metrics: this.config.metrics }),
      onActivity: () => {
        this.stalenessGuard.record();
        this.publishWatchlistMetrics();
      },
      ...(this.config.coldStartLookbackBlocks === undefined
        ? {}
        : { coldStartLookbackBlocks: this.config.coldStartLookbackBlocks }),
    });
    await this.seedColdStart();
    await this.runColdStartFullSweep(this.config.chain);
    await this.eventWatchlist.start();
    this.stalenessGuard.record();
    this.publishWatchlistMetrics();
    this.started = true;
    this.config.logger.info("watchlist_coordinator_started", {
      chain: this.config.chain,
      watchlistSize: this.watchlist.size(),
      pool: this.config.poolAddress,
      cursorBackend: this.cursor.backend,
    });
  }

  public async stop(): Promise<void> {
    this.eventWatchlist?.stop();
    await this.cursor?.close();
    this.started = false;
  }

  public async getBorrowersForReserve(chain: SupportedChain, reserve: Address): Promise<Address[]> {
    return this.snapshotProvider.getBorrowersForReserve(chain, reserve);
  }

  public async refreshBorrowers(
    chain: SupportedChain,
    accounts: readonly Address[],
  ): Promise<readonly BorrowerSnapshot[]> {
    return this.snapshotProvider.refreshBorrowers(chain, accounts);
  }

  public async refreshWatchlistBorrowers(
    chain: SupportedChain,
    accounts: readonly Address[],
  ): Promise<readonly BorrowerSnapshot[]> {
    return this.snapshotProvider.refreshWatchlistBorrowers(chain, accounts);
  }

  public async sweepAndRefresh(
    chain: SupportedChain,
    blockNumber?: bigint,
  ): Promise<void> {
    if (!this.started || this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      await this.runTieredSweep(chain, blockNumber);
    } finally {
      this.sweepInFlight = false;
    }
  }

  public async pollBorrowers(chain: SupportedChain): Promise<readonly BorrowerSnapshot[]> {
    return this.runTieredSweep(chain);
  }

  private async runTieredSweep(
    chain: SupportedChain,
    blockNumber?: bigint,
  ): Promise<readonly BorrowerSnapshot[]> {
    const block = blockNumber ?? await this.config.readClient.getBlockNumber();
    const targets = filterAddressesForSweep(
      this.watchlist,
      block,
      this.config.lowTierEveryBlocks ?? 100n,
    );
    if (targets.length === 0) {
      this.stalenessGuard.record();
      this.publishWatchlistMetrics();
      return [];
    }

    const sweepStartedAt = Date.now();
    const liquidatable = await sweepHealthFactors(targets, {
      client: this.config.readClient,
      poolAddress: this.config.poolAddress,
      watchlist: this.watchlist,
      ...(this.config.multicallBatchSize === undefined
        ? {}
        : { batchSize: this.config.multicallBatchSize }),
      minDebtBase: this.config.minDebtBase,
    });
    this.config.metrics?.recordWatchlistSweepLatency(
      (Date.now() - sweepStartedAt) / 1_000,
      {
        chain,
        batchSize: this.config.multicallBatchSize ?? 250,
        addresses: targets.length,
      },
    );

    const snapshots: BorrowerSnapshot[] = [];
    for (const account of liquidatable) {
      const refreshed = await this.snapshotProvider.refreshBorrowers(chain, [account.address]);
      snapshots.push(...refreshed);
      for (const snapshot of refreshed) {
        this.config.logger.info("liquidation_path_candidate", {
          chain,
          account: snapshot.account,
          healthFactor: snapshot.healthFactor.toString(),
          debtBase: account.totalDebtBase.toString(),
          stage: "sweep_to_snapshot",
        });
      }
    }

    this.stalenessGuard.record();
    this.publishWatchlistMetrics();
    this.config.logger.info("watchlist_sweep_complete", {
      chain,
      blockNumber: block.toString(),
      scanned: targets.length,
      liquidatable: snapshots.length,
      watchlistSize: this.watchlist.size(),
      durationMs: Date.now() - sweepStartedAt,
    });
    return snapshots;
  }

  private publishWatchlistMetrics(): void {
    this.config.metrics?.setWatchlistSize(this.config.chain, this.watchlist.size());
    this.config.metrics?.setWatchlistLastUpdateAge(this.config.chain, this.stalenessGuard.ageMs() / 1_000);
  }

  private async runColdStartFullSweep(chain: SupportedChain): Promise<readonly BorrowerSnapshot[]> {
    const targets = this.watchlist.addresses() as Address[];
    if (targets.length === 0) {
      this.stalenessGuard.record();
      return [];
    }

    const sweepStartedAt = Date.now();
    const liquidatable = await sweepHealthFactors(targets, {
      client: this.config.readClient,
      poolAddress: this.config.poolAddress,
      watchlist: this.watchlist,
      ...(this.config.multicallBatchSize === undefined
        ? {}
        : { batchSize: this.config.multicallBatchSize }),
      minDebtBase: this.config.minDebtBase,
    });

    const snapshots: BorrowerSnapshot[] = [];
    for (const account of liquidatable) {
      const refreshed = await this.snapshotProvider.refreshBorrowers(chain, [account.address]);
      snapshots.push(...refreshed);
      for (const snapshot of refreshed) {
        this.config.logger.info("liquidation_path_candidate", {
          chain,
          account: snapshot.account,
          healthFactor: snapshot.healthFactor.toString(),
          debtBase: account.totalDebtBase.toString(),
          stage: "cold_start_full_sweep",
        });
      }
    }

    this.stalenessGuard.record();
    this.publishWatchlistMetrics();
    this.config.logger.info("cold_start_full_sweep_complete", {
      chain,
      scanned: targets.length,
      liquidatable: snapshots.length,
      watchlistSize: this.watchlist.size(),
      durationMs: Date.now() - sweepStartedAt,
    });
    return snapshots;
  }

  private async seedColdStart(): Promise<void> {
    try {
      const addresses = await this.config.protocol.listBorrowerAddresses?.();
      if (addresses !== undefined && addresses.length > 0) {
        const blockNumber = await this.config.readClient.getBlockNumber();
        for (const address of addresses) {
          this.watchlist.add(address, blockNumber);
        }
        this.config.logger.info("watchlist_cold_start_subgraph", {
          chain: this.config.chain,
          borrowers: addresses.length,
        });
        return;
      }
      this.config.logger.warn("watchlist_cold_start_subgraph_empty", {
        chain: this.config.chain,
      });
    } catch (error) {
      this.config.logger.warn("watchlist_cold_start_subgraph_failed", {
        chain: this.config.chain,
        error: String(error),
      });
    }

    const lookback = this.config.coldStartLookbackBlocks ?? 50_000n;
    try {
      if (this.eventWatchlist === undefined) {
        throw new Error("event watchlist not initialized");
      }
      await this.eventWatchlist.coldStartFromLogs(lookback);
      const size = this.watchlist.size();
      if (size === 0) {
        throw new Error("RPC cold-start fallback returned zero borrowers");
      }
      this.config.logger.info("watchlist_cold_start_rpc_fallback", {
        chain: this.config.chain,
        lookbackBlocks: lookback.toString(),
        watchlistSize: size,
      });
    } catch (error) {
      this.config.logger.error("watchlist_cold_start_critical", {
        chain: this.config.chain,
        error: String(error),
        watchlistSize: this.watchlist.size(),
      });
    }
  }
}
