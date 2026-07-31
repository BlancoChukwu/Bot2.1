import type { Address, PublicClient } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { ChainRegistry } from "../config/chainRegistry";
import type { SupportedChain } from "../config/chains";
import type { AaveV3Protocol } from "../protocols/aaveV3";
import type { BorrowerIndexProvider } from "../indexing/BorrowerIndexProvider";
import { BlockCursor, createBlockCursor } from "../utils/blockCursor";
import { AaveSnapshotProvider } from "./aaveSnapshotProvider";
import type { BorrowerSnapshotProvider } from "./hybridDetectionPipeline";
import { BoundedWatchlist } from "./boundedWatchlist";
import { EventDrivenWatchlist } from "./eventDrivenWatchlist";
import {
  filterAddressesForSweep,
  filterReadsBelowHealthFactor,
  PIPELINE_DIAGNOSTIC_HF_WAD,
  readHealthFactors,
  sweepHealthFactors,
  type HealthFactorRead,
} from "./healthFactorSweep";
import type { BorrowerSnapshot } from "./reserveAwareBorrowerCache";
import { StalenessGuard } from "./stalenessGuard";
import {
  discoverBorrowersFromLogs,
  filterAccountsWithDebt,
} from "./onChainBorrowerDiscovery";
import { parseWatchlistReserveAllowlist } from "../config/watchlistReserveAllowlist";
import { filterAccountsTouchingReserveAllowlist } from "../config/watchlistReserveFilter";
import { getChainConfig } from "../config/chains";

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
  readonly maxStaleMs?: number;
  readonly redisUrl?: string;
  readonly coldStartLookbackBlocks?: bigint;
  readonly fullSweepIntervalMs?: number;
  readonly onSnapshots?: (snapshots: readonly BorrowerSnapshot[]) => void;
  readonly reorgSafeDepth?: bigint;
  readonly gapChunkBlocks?: bigint;
  readonly gapChunkDelayMs?: number;
  readonly borrowerIndexProvider?: BorrowerIndexProvider;
  readonly reserveAllowlist?: readonly Address[];
  readonly onChainColdStartLookbackBlocks?: bigint;
  readonly onChainColdStartMaxBlocks?: bigint;
  /** Archive-capable HTTP RPC for log backfill (not Flashblocks pending-only). */
  readonly coldStartReadClient?: PublicClient;
  /** `onchain` skips subgraph seed (avoids broken `positions` schema / quota errors). */
  readonly coldStartIndexer?: string;
  /** When true, do not block `start()` on the initial HF sweep (runs in background). */
  readonly skipColdStartFullSweep?: boolean;
  /** When true, EventPurityStack owns WS ingestion; skip duplicate EventDrivenWatchlist. */
  readonly deferToEventPurityStack?: boolean;
}

export class WatchlistCoordinator implements BorrowerSnapshotProvider {
  public readonly stalenessGuard: StalenessGuard;
  public readonly watchlist = new BoundedWatchlist();
  private borrowersDiscovered = 0;
  private diagnosticSampleCursor = 0;
  private readonly snapshotProvider: AaveSnapshotProvider;
  private cursor: BlockCursor | undefined;
  private eventWatchlist: EventDrivenWatchlist | undefined;
  private started = false;
  private sweepInFlight = false;
  private fullSweepTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly config: WatchlistCoordinatorConfig) {
    this.stalenessGuard = new StalenessGuard(config.maxStaleMs);
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
      onAccountsActivity: (accounts) => {
        void this.refreshActiveAccounts(accounts);
      },
      ...(this.config.coldStartLookbackBlocks === undefined
        ? {}
        : { coldStartLookbackBlocks: this.config.coldStartLookbackBlocks }),
      ...(this.config.reorgSafeDepth === undefined ? {} : { reorgSafeDepth: this.config.reorgSafeDepth }),
      ...(this.config.gapChunkBlocks === undefined ? {} : { gapChunkBlocks: this.config.gapChunkBlocks }),
      ...(this.config.gapChunkDelayMs === undefined ? {} : { gapChunkDelayMs: this.config.gapChunkDelayMs }),
    });
    await this.seedColdStart();
    if (this.config.skipColdStartFullSweep === true) {
      this.config.logger.info("cold_start_full_sweep_deferred", {
        chain: this.config.chain,
        watchlistSize: this.watchlist.size(),
      });
      void this.runColdStartFullSweep(this.config.chain).catch((error) => {
        this.config.logger.error("cold_start_full_sweep_failed", {
          chain: this.config.chain,
          error: String(error),
        });
      });
    } else {
      await this.runColdStartFullSweep(this.config.chain);
    }
    if (this.config.deferToEventPurityStack !== true) {
      await this.eventWatchlist.start();
    } else {
      this.config.logger.info("event_driven_watchlist_deferred", {
        chain: this.config.chain,
        reason: "event_purity_stack",
      });
    }
    this.stalenessGuard.record();
    this.publishWatchlistMetrics();
    this.started = true;
    const fullSweepIntervalMs = this.config.fullSweepIntervalMs ?? 60_000;
    if (fullSweepIntervalMs > 0) {
      this.fullSweepTimer = setInterval(() => {
        Promise.resolve()
          .then(() => this.pollBorrowers(this.config.chain))
          .catch((error) => {
            this.config.logger.error("watchlist_full_safety_sweep_failed", {
              chain: this.config.chain,
              error: String(error),
            });
          });
      }, fullSweepIntervalMs);
      this.fullSweepTimer.unref?.();
    }
    this.config.logger.info("watchlist_coordinator_started", {
      chain: this.config.chain,
      watchlistSize: this.watchlist.size(),
      pool: this.config.poolAddress,
      cursorBackend: this.cursor.backend,
      fullSweepIntervalMs,
    });
  }

  public async stop(): Promise<void> {
    if (this.fullSweepTimer !== undefined) {
      clearInterval(this.fullSweepTimer);
      this.fullSweepTimer = undefined;
    }
    this.eventWatchlist?.stop();
    await this.cursor?.close();
    this.started = false;
  }

  public async getBorrowersForReserve(_chain: SupportedChain, _reserve: Address): Promise<Address[]> {
    return this.watchlist.addresses() as Address[];
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

  public async refreshBorrowersForDiagnostics(
    chain: SupportedChain,
    accounts: readonly Address[],
  ): Promise<readonly BorrowerSnapshot[]> {
    return this.snapshotProvider.refreshBorrowersForDiagnostics(chain, accounts);
  }

  /** Rotating multicall HF sample for pipeline_cycle_diagnostics (success gate). */
  public async sampleDiagnosticHealthFactors(batchSize = 120): Promise<readonly HealthFactorRead[]> {
    const addresses = this.watchlist.addresses() as Address[];
    if (addresses.length === 0) {
      return [];
    }
    const size = Math.min(batchSize, addresses.length);
    const start = this.diagnosticSampleCursor % addresses.length;
    const batch: Address[] = [];
    for (let i = 0; i < size; i += 1) {
      batch.push(addresses[(start + i) % addresses.length]!);
    }
    this.diagnosticSampleCursor = (start + size) % addresses.length;
    const reads = await readHealthFactors(batch, {
      client: this.config.readClient,
      poolAddress: this.config.poolAddress,
      minDebtBase: this.config.minDebtBase,
      watchlist: this.watchlist,
      ...(this.config.multicallBatchSize === undefined
        ? {}
        : { batchSize: this.config.multicallBatchSize }),
    });
    return filterReadsBelowHealthFactor(reads, PIPELINE_DIAGNOSTIC_HF_WAD, this.config.minDebtBase);
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

  public async refreshPriorityAccounts(accounts: readonly Address[]): Promise<void> {
    return this.refreshActiveAccounts(accounts);
  }

  /** Heartbeat for event-purity / WS activity when classic sweeps are disabled. */
  public touchActivity(): void {
    this.stalenessGuard.record();
    this.publishWatchlistMetrics();
  }

  public registerBorrowers(accounts: readonly Address[], blockNumber?: bigint): number {
    if (accounts.length === 0) {
      return 0;
    }
    const block = blockNumber ?? 0n;
    let added = 0;
    for (const account of accounts) {
      const before = this.watchlist.size();
      this.watchlist.add(account, block);
      if (this.watchlist.size() > before) {
        added += 1;
      }
    }
    this.borrowersDiscovered += added;
    // Any inbound account batch is live activity — do not require net-new adds.
    this.touchActivity();
    if (added > 0) {
      this.config.logger.info("watchlist_borrowers_registered", {
        chain: this.config.chain,
        added,
        watchlistSize: this.watchlist.size(),
        borrowersDiscovered: this.borrowersDiscovered,
      });
    }
    return added;
  }

  public getWatchlistStats(): { readonly watchlistSize: number; readonly borrowersDiscovered: number } {
    return {
      watchlistSize: this.watchlist.size(),
      borrowersDiscovered: this.borrowersDiscovered,
    };
  }

  private async refreshActiveAccounts(accounts: readonly Address[]): Promise<void> {
    if (!this.started || accounts.length === 0) {
      return;
    }
    const snapshots = await this.snapshotProvider.refreshWatchlistBorrowers(this.config.chain, accounts);
    if (snapshots.length === 0) {
      return;
    }
    this.touchActivity();
    this.config.onSnapshots?.(snapshots);
    this.config.logger.info("watchlist_event_target_refresh_complete", {
      chain: this.config.chain,
      touchedAccounts: accounts.length,
      refreshed: snapshots.length,
    });
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
    const indexer = (this.config.coldStartIndexer ?? "onchain").trim().toLowerCase();
    if (indexer === "onchain") {
      this.config.logger.info("watchlist_cold_start_on_chain_only", {
        chain: this.config.chain,
        indexer,
      });
    } else if (indexer !== "onchain") {
      try {
        const seeded = this.config.borrowerIndexProvider === undefined
          ? {
            source: "subgraph" as const,
            accounts: await this.config.protocol.listBorrowerAddresses?.() ?? [],
          }
          : await this.config.borrowerIndexProvider.seed(this.config.chain);
      const addresses = seeded.accounts;
      if (addresses !== undefined && addresses.length > 0) {
        const blockNumber = await this.config.readClient.getBlockNumber();
        for (const address of addresses) {
          this.watchlist.add(address, blockNumber);
        }
        this.config.logger.info("watchlist_cold_start_subgraph", {
          chain: this.config.chain,
          borrowers: addresses.length,
          source: seeded.source,
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
    }

    const lookback = this.config.onChainColdStartLookbackBlocks
      ?? this.config.coldStartLookbackBlocks
      ?? 200_000n;
    const maxBlocks = this.config.onChainColdStartMaxBlocks ?? 200_000n;
    const coldStartClient = this.config.coldStartReadClient ?? this.config.readClient;
    try {
      const discovery = await discoverBorrowersFromLogs({
        chain: this.config.chain,
        poolAddress: this.config.poolAddress,
        client: coldStartClient,
        lookbackBlocks: lookback,
        maxBlocks,
        chunkBlocks: 5_000n,
      });
      const withDebt = await filterAccountsWithDebt(
        this.config.readClient,
        this.config.poolAddress,
        discovery.accounts,
      );
      const blockNumber = await this.config.readClient.getBlockNumber();
      for (const address of withDebt) {
        this.watchlist.add(address, blockNumber);
      }
      if (this.watchlist.size() === 0 && this.eventWatchlist !== undefined) {
        await this.eventWatchlist.coldStartFromLogs(lookback);
      }
      const size = this.watchlist.size();
      if (size === 0) {
        throw new Error("on-chain and log cold-start returned zero borrowers");
      }
      this.borrowersDiscovered = this.watchlist.size();
      const beforePrune = withDebt;
      this.config.logger.info("watchlist_cold_start_on_chain", {
        chain: this.config.chain,
        lookbackBlocks: lookback.toString(),
        borrowLogs: discovery.borrowLogs,
        discovered: discovery.accounts.length,
        withDebt: withDebt.length,
        borrowersDiscovered: this.borrowersDiscovered,
        watchlistSize: this.watchlist.size(),
        elapsedMs: discovery.elapsedMs,
        blocksScanned: discovery.blocksScanned.toString(),
      });
      const runReservePrune = async (): Promise<void> => {
        await this.pruneWatchlistByReserveAllowlist();
        if (this.watchlist.size() < 100 && beforePrune.length >= 100) {
          for (const account of beforePrune) {
            this.watchlist.add(account, blockNumber);
          }
          this.config.logger.warn("watchlist_reserve_allowlist_prune_reverted", {
            chain: this.config.chain,
            restored: beforePrune.length,
            watchlistSize: this.watchlist.size(),
          });
        }
      };
      if (this.config.skipColdStartFullSweep === true) {
        this.config.logger.info("watchlist_reserve_allowlist_prune_deferred", {
          chain: this.config.chain,
          watchlistSize: this.watchlist.size(),
        });
        void runReservePrune().catch((error) => {
          this.config.logger.error("watchlist_reserve_allowlist_prune_failed", {
            chain: this.config.chain,
            error: String(error),
          });
        });
      } else {
        await runReservePrune();
      }
    } catch (error) {
      this.config.logger.error("watchlist_cold_start_critical", {
        chain: this.config.chain,
        error: String(error),
        watchlistSize: this.watchlist.size(),
      });
    }
  }

  private async pruneWatchlistByReserveAllowlist(): Promise<void> {
    const allowlist = this.config.reserveAllowlist
      ?? parseWatchlistReserveAllowlist(process.env.WATCHLIST_RESERVE_ALLOWLIST, this.config.chain);
    if (allowlist.length === 0) {
      return;
    }
    const accounts = this.watchlist.addresses() as Address[];
    if (accounts.length === 0) {
      return;
    }
    const chainConfig = getChainConfig(this.config.chain);
    const allowed = await filterAccountsTouchingReserveAllowlist({
      client: this.config.readClient,
      uiPoolDataProvider: chainConfig.aave.uiPoolDataProvider,
      poolAddressesProvider: chainConfig.aave.poolAddressesProvider,
      accounts,
      allowlist,
      batchSize: this.config.multicallBatchSize ?? 250,
    });
    let pruned = 0;
    for (const account of accounts) {
      if (!allowed.has(account.toLowerCase())) {
        this.watchlist.remove(account);
        pruned += 1;
      }
    }
    this.config.logger.info("watchlist_reserve_allowlist_prune", {
      chain: this.config.chain,
      pruned,
      remaining: this.watchlist.size(),
      allowlistSize: allowlist.length,
    });
  }
}
