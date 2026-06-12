export interface EventPurityConfig {
  readonly enableArbitrage: boolean;
  readonly enableLiveTx: boolean;
  readonly enableWatchTierConfirm: boolean;
  readonly localHfUrgent: number;
  readonly localHfWatch: number;
  readonly reserveIndexRefreshBlocks: bigint;
  readonly positionEvictionHfThreshold: number;
  readonly positionEvictionInactiveBlocks: bigint;
  readonly positionCacheHardCap: number;
  readonly shadowSampleRate: number;
  readonly shadowDriftToleranceBps: number;
  readonly shadowFnRateTargetPct: number;
  readonly shadowMaxSamplesPerDay: number;
  readonly bootstrapEnabled: boolean;
  readonly bootstrapLookbackDays: number;
  readonly bootstrapCacheEnabled: boolean;
  readonly bootstrapCacheTtlHours: number;
}

const DEFAULT_EVICTION_INACTIVE_BLOCKS = 103_680n;

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

function parseNonNegativeNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parsePositiveBigInt(value: string | undefined, fallback: bigint, name: string): bigint {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  try {
    const parsed = BigInt(value.trim());
    if (parsed <= 0n) {
      throw new Error(`${name} must be positive`);
    }
    return parsed;
  } catch {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function parseEventPurityConfig(env: Record<string, string | undefined>): EventPurityConfig {
  return {
    enableArbitrage: parseBoolean(env.ENABLE_ARBITRAGE, false),
    enableLiveTx: parseBoolean(env.ENABLE_LIVE_TX, false),
    enableWatchTierConfirm: parseBoolean(env.ENABLE_WATCH_TIER_CONFIRM, false),
    localHfUrgent: parsePositiveNumber(env.LOCAL_HF_URGENT, 1.05, "LOCAL_HF_URGENT"),
    localHfWatch: parsePositiveNumber(env.LOCAL_HF_WATCH, 1.10, "LOCAL_HF_WATCH"),
    reserveIndexRefreshBlocks: parsePositiveBigInt(env.RESERVE_INDEX_REFRESH_BLOCKS, 100n, "RESERVE_INDEX_REFRESH_BLOCKS"),
    positionEvictionHfThreshold: parsePositiveNumber(env.POSITION_EVICTION_HF_THRESHOLD, 1.5, "POSITION_EVICTION_HF_THRESHOLD"),
    positionEvictionInactiveBlocks: parsePositiveBigInt(
      env.POSITION_EVICTION_INACTIVE_BLOCKS,
      DEFAULT_EVICTION_INACTIVE_BLOCKS,
      "POSITION_EVICTION_INACTIVE_BLOCKS",
    ),
    positionCacheHardCap: parsePositiveNumber(env.POSITION_CACHE_HARD_CAP, 50_000, "POSITION_CACHE_HARD_CAP"),
    shadowSampleRate: parsePositiveNumber(env.SHADOW_SAMPLE_RATE, 100, "SHADOW_SAMPLE_RATE"),
    shadowDriftToleranceBps: parseNonNegativeNumber(env.SHADOW_DRIFT_TOLERANCE_BPS, 50, "SHADOW_DRIFT_TOLERANCE_BPS"),
    shadowFnRateTargetPct: parseNonNegativeNumber(env.SHADOW_FN_RATE_TARGET_PCT, 1.0, "SHADOW_FN_RATE_TARGET_PCT"),
    shadowMaxSamplesPerDay: parsePositiveNumber(env.SHADOW_MAX_SAMPLES_PER_DAY, 500, "SHADOW_MAX_SAMPLES_PER_DAY"),
    bootstrapEnabled: parseBoolean(env.BOOTSTRAP_ENABLED, true),
    bootstrapLookbackDays: parsePositiveNumber(env.BOOTSTRAP_LOOKBACK_DAYS, 14, "BOOTSTRAP_LOOKBACK_DAYS"),
    bootstrapCacheEnabled: parseBoolean(env.BOOTSTRAP_CACHE_ENABLED, true),
    bootstrapCacheTtlHours: parsePositiveNumber(env.BOOTSTRAP_CACHE_TTL_HOURS, 24, "BOOTSTRAP_CACHE_TTL_HOURS"),
  };
}

export function hfThresholdToWad(threshold: number): bigint {
  return BigInt(Math.trunc(threshold * 1e18));
}
