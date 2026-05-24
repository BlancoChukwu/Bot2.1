import type { Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";
import type { AaveV3Protocol } from "../protocols/aaveV3";
import { computeSubgraphLag, fetchSubgraphIndexedBlock } from "../utils/subgraphMeta";
import type { BorrowerSnapshotProvider } from "./hybridDetectionPipeline";
import type { ReserveAwareBorrowerCache } from "./reserveAwareBorrowerCache";
import { RescanCircuitBreaker } from "./rescanCircuitBreaker";

/** HF < 1.05 (wad scale) — pre-liquidatable watchlist. */
export const preLiquidatableHealthFactorWad = 1_050_000_000_000_000_000n;

export interface SubgraphLagCheckConfig {
  readonly subgraphUrl: string;
  readonly getChainBlockNumber: () => Promise<bigint>;
  readonly maxLagBlocks?: number;
  readonly skipRescanWhenLagExceeds?: number;
}

export interface BorrowerWatchlistRescannerConfig {
  readonly chain: SupportedChain;
  readonly protocol: AaveV3Protocol;
  readonly provider: BorrowerSnapshotProvider;
  readonly cache: ReserveAwareBorrowerCache;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly intervalMs?: number;
  readonly fetchBorrowers?: () => Promise<readonly Address[]>;
  readonly subgraphLagCheck?: SubgraphLagCheckConfig;
  readonly enableNonAaveLiquidation?: boolean;
}

export interface BorrowerWatchlistRescannerHandle {
  stop(): void;
  triggerRescan(reason: string, blockNumber?: bigint): void;
}

export function startBorrowerWatchlistRescanner(
  config: BorrowerWatchlistRescannerConfig,
): BorrowerWatchlistRescannerHandle {
  const intervalMs = config.intervalMs ?? 15 * 60 * 1_000;
  const breaker = new RescanCircuitBreaker({
    logger: config.logger,
    onOpen: () => config.metrics.recordError(),
  });
  const run = (reason: string, blockNumber?: bigint) => {
    void breaker.execute(
      async () => {
        await triggerBorrowerWatchlistRescan(config, reason, blockNumber);
      },
      (error) => {
        config.metrics.recordError();
        config.logger.error("borrower_watchlist_rescan_failed", {
          chain: config.chain,
          reason,
          error: String(error),
        });
      },
    );
  };
  run("interval");
  const timer = setInterval(() => run("interval"), intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      breaker.stop();
    },
    triggerRescan: (reason, blockNumber) => run(reason, blockNumber),
  };
}

export function triggerBorrowerWatchlistRescan(
  config: BorrowerWatchlistRescannerConfig,
  reason: string,
  blockNumber?: bigint,
): Promise<{ readonly scanned: number; readonly watchlisted: number }> {
  return rescanBorrowerWatchlist(config, reason, blockNumber);
}

export async function rescanBorrowerWatchlist(
  config: BorrowerWatchlistRescannerConfig,
  reason = "manual",
  blockNumber?: bigint,
): Promise<{ readonly scanned: number; readonly watchlisted: number }> {
  const startedAt = Date.now();
  if (config.subgraphLagCheck !== undefined) {
    const lagResult = await evaluateSubgraphLag(config);
    if (lagResult.skipRescan) {
      config.logger.warn("borrower_watchlist_rescan_skipped_subgraph_lag", {
        chain: config.chain,
        reason,
        blocksBehind: lagResult.blocksBehind.toString(),
      });
      return { scanned: 0, watchlisted: 0 };
    }
  }

  const accounts = config.fetchBorrowers === undefined
    ? await fetchBorrowersNearLiquidation(config.protocol, preLiquidatableHealthFactorWad)
    : await config.fetchBorrowers();
  const watchlistAccounts = accounts.filter((account) => account !== undefined);
  if (watchlistAccounts.length === 0) {
    config.logger.info("borrower_watchlist_rescan_complete", {
      chain: config.chain,
      reason,
      blockNumber: blockNumber?.toString(),
      scanned: 0,
      watchlisted: 0,
      durationMs: Date.now() - startedAt,
    });
    return { scanned: 0, watchlisted: 0 };
  }

  const snapshots = config.provider.refreshWatchlistBorrowers === undefined
    ? await config.provider.refreshBorrowers(config.chain, watchlistAccounts)
    : await config.provider.refreshWatchlistBorrowers(config.chain, watchlistAccounts);
  for (const snapshot of snapshots) {
    config.cache.upsert(snapshot);
  }
  const liquidatable = snapshots.filter((s) => s.healthFactor < 1_000_000_000_000_000_000n).length;
  if (config.enableNonAaveLiquidation !== true) {
    const nonAave = watchlistAccounts.length - snapshots.length;
    if (nonAave > 0) {
      config.logger.info("borrower_non_aave_skipped", {
        chain: config.chain,
        skipped: nonAave,
        enableNonAaveLiquidation: false,
      });
    }
  }

  config.logger.info("borrower_watchlist_rescan_complete", {
    chain: config.chain,
    reason,
    blockNumber: blockNumber?.toString(),
    scanned: watchlistAccounts.length,
    watchlisted: snapshots.length,
    nearLiquidatable: liquidatable,
    durationMs: Date.now() - startedAt,
  });
  config.metrics.recordLatency("scan", (Date.now() - startedAt) / 1_000, {
    chain: config.chain,
  });
  return { scanned: watchlistAccounts.length, watchlisted: snapshots.length };
}

async function evaluateSubgraphLag(
  config: BorrowerWatchlistRescannerConfig,
): Promise<{ readonly blocksBehind: bigint; readonly skipRescan: boolean }> {
  const lagCheck = config.subgraphLagCheck;
  if (lagCheck === undefined) {
    return { blocksBehind: 0n, skipRescan: false };
  }
  const maxLag = BigInt(lagCheck.maxLagBlocks ?? 10);
  const skipThreshold = BigInt(lagCheck.skipRescanWhenLagExceeds ?? 50);
  const [indexedBlock, currentBlock] = await Promise.all([
    fetchSubgraphIndexedBlock(lagCheck.subgraphUrl),
    lagCheck.getChainBlockNumber(),
  ]);
  const blocksBehind = computeSubgraphLag(currentBlock, indexedBlock);
  if (blocksBehind > maxLag) {
    if (config.metrics.recordSubgraphLag !== undefined) {
      config.metrics.recordSubgraphLag(Number(blocksBehind));
    }
    config.logger.warn("subgraph_lag_detected", {
      chain: config.chain,
      event: "subgraph_lag_detected",
      blocksBehind: blocksBehind.toString(),
      indexedBlock: indexedBlock.toString(),
      currentBlock: currentBlock.toString(),
    });
  }
  return { blocksBehind, skipRescan: blocksBehind > skipThreshold };
}

export async function fetchBorrowersNearLiquidation(
  protocol: AaveV3Protocol,
  hfThresholdWad: bigint,
): Promise<Address[]> {
  if (protocol.listBorrowerAddresses === undefined || protocol.getUserAccount === undefined) {
    return [];
  }
  const addresses = await protocol.listBorrowerAddresses();
  const matched: Address[] = [];
  for (const account of addresses) {
    const user = await protocol.getUserAccount(account);
    if (user.totalDebtBase <= 0n) {
      continue;
    }
    if (user.healthFactor <= hfThresholdWad) {
      matched.push(account);
    }
  }
  return matched;
}

export function createDebouncedBlockRescan(
  trigger: (reason: string, blockNumber: bigint) => void,
  debounceMs: number,
): (blockNumber: bigint) => void {
  let lastRunMs = 0;
  let pending: NodeJS.Timeout | undefined;
  let pendingBlock: bigint | undefined;
  return (blockNumber: bigint) => {
    pendingBlock = blockNumber;
    if (pending !== undefined) {
      clearTimeout(pending);
    }
    const elapsed = Date.now() - lastRunMs;
    const delay = Math.max(0, debounceMs - elapsed);
    pending = setTimeout(() => {
      pending = undefined;
      if (pendingBlock === undefined) {
        return;
      }
      lastRunMs = Date.now();
      trigger("block", pendingBlock);
      pendingBlock = undefined;
    }, delay);
    pending.unref?.();
  };
}
