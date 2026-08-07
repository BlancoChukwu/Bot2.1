import { hfThresholdToWad } from "./eventPurityConfig";

export interface PrestageConfig {
  readonly enabled: boolean;
  readonly hfUpper: number;
  readonly hfUpperWad: bigint;
  readonly topN: number;
  readonly ttlMs: number;
  /** Hard per-account refresh backstop (default 1500ms). */
  readonly minRefreshIntervalMs: number;
  /**
   * Oracle-move invalidation threshold in bps.
   * Reuses LIQUIDATION_SWAP_SLIPPAGE_BPS (receiver-v5 oracle-floor constant) — no second dial.
   */
  readonly oracleInvalidateBps: number;
  /** Snapshot age above which refreshBorrowers is allowed (tighter than TTL). */
  readonly snapshotRefreshAgeMs: number;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const parsed = parsePositiveNumber(value, fallback, name);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return Math.trunc(parsed);
}

/**
 * Parse PRESTAGE_* env. Oracle invalidate bps = LIQUIDATION_SWAP_SLIPPAGE_BPS (shared).
 * PRESTAGE_ENABLED defaults true when USE_EVENT_WATCHLIST=true.
 */
export function parsePrestageConfig(env: Record<string, string | undefined>): PrestageConfig {
  const useEventWatchlist = parseBoolean(env.USE_EVENT_WATCHLIST, false);
  const enabled = parseBoolean(env.PRESTAGE_ENABLED, useEventWatchlist);
  const hfUpper = parsePositiveNumber(env.PRESTAGE_HF_UPPER, 1.02, "PRESTAGE_HF_UPPER");
  const topN = parseBoundedInt(env.PRESTAGE_TOP_N, 10, 1, 50, "PRESTAGE_TOP_N");
  const ttlMs = parseBoundedInt(env.PRESTAGE_TTL_MS, 15_000, 1_000, 120_000, "PRESTAGE_TTL_MS");
  const minRefreshIntervalMs = parseBoundedInt(
    env.PRESTAGE_MIN_REFRESH_INTERVAL_MS,
    1_500,
    1_000,
    2_000,
    "PRESTAGE_MIN_REFRESH_INTERVAL_MS",
  );
  const oracleInvalidateBps = parseBoundedInt(
    env.LIQUIDATION_SWAP_SLIPPAGE_BPS,
    200,
    1,
    1_000,
    "LIQUIDATION_SWAP_SLIPPAGE_BPS",
  );
  const snapshotRefreshAgeMs = Math.min(
    ttlMs,
    parseBoundedInt(
      env.PRESTAGE_SNAPSHOT_REFRESH_AGE_MS,
      Math.max(1_000, Math.floor(ttlMs / 3)),
      500,
      ttlMs,
      "PRESTAGE_SNAPSHOT_REFRESH_AGE_MS",
    ),
  );

  return {
    enabled,
    hfUpper,
    hfUpperWad: hfThresholdToWad(hfUpper),
    topN,
    ttlMs,
    minRefreshIntervalMs,
    oracleInvalidateBps,
    snapshotRefreshAgeMs,
  };
}
