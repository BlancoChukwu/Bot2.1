import type { Address } from "viem";
import type { BotMetrics, LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";
import type { AaveV3Protocol } from "../protocols/aaveV3";
import type { BorrowerSnapshotProvider } from "./hybridDetectionPipeline";
import type { ReserveAwareBorrowerCache } from "./reserveAwareBorrowerCache";

/** HF < 1.05 (wad scale) — pre-liquidatable watchlist. */
export const preLiquidatableHealthFactorWad = 1_050_000_000_000_000_000n;

export interface BorrowerWatchlistRescannerConfig {
  readonly chain: SupportedChain;
  readonly protocol: AaveV3Protocol;
  readonly provider: BorrowerSnapshotProvider;
  readonly cache: ReserveAwareBorrowerCache;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly intervalMs?: number;
  readonly fetchBorrowers?: () => Promise<readonly Address[]>;
}

export interface BorrowerWatchlistRescannerHandle {
  stop(): void;
}

export function startBorrowerWatchlistRescanner(
  config: BorrowerWatchlistRescannerConfig,
): BorrowerWatchlistRescannerHandle {
  const intervalMs = config.intervalMs ?? 15 * 60 * 1_000;
  const run = () => {
    void rescanBorrowerWatchlist(config).catch((error) => {
      config.metrics.recordError();
      config.logger.error("borrower_watchlist_rescan_failed", { chain: config.chain, error: String(error) });
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

export async function rescanBorrowerWatchlist(
  config: BorrowerWatchlistRescannerConfig,
): Promise<{ readonly scanned: number; readonly watchlisted: number }> {
  const startedAt = Date.now();
  const accounts = config.fetchBorrowers === undefined
    ? await fetchBorrowersNearLiquidation(config.protocol, preLiquidatableHealthFactorWad)
    : await config.fetchBorrowers();
  const watchlistAccounts = accounts.filter((account) => account !== undefined);
  if (watchlistAccounts.length === 0) {
    config.logger.info("borrower_watchlist_rescan_complete", {
      chain: config.chain,
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

  config.logger.info("borrower_watchlist_rescan_complete", {
    chain: config.chain,
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
