export interface MemoryAttributionCounters {
  readonly wsSubs?: number;
  readonly inFlightRpc?: number;
  readonly shadowQueueDepth?: number;
}

export interface MemoryAttributionSnapshot {
  readonly t: number;
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
  readonly rssWarnMb: number;
  readonly wsSubs: number;
  readonly inFlightRpc: number;
  readonly shadowQueueDepth: number;
  readonly msg: "memory_snapshot";
}

export function buildMemoryAttributionSnapshot(input: {
  readonly rssWarnMb: number;
  readonly counters?: MemoryAttributionCounters;
}): MemoryAttributionSnapshot {
  const mem = process.memoryUsage();
  return {
    t: Date.now(),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    externalMb: Math.round(mem.external / 1024 / 1024),
    arrayBuffersMb: Math.round(mem.arrayBuffers / 1024 / 1024),
    rssWarnMb: input.rssWarnMb,
    wsSubs: input.counters?.wsSubs ?? 0,
    inFlightRpc: input.counters?.inFlightRpc ?? 0,
    shadowQueueDepth: input.counters?.shadowQueueDepth ?? 0,
    msg: "memory_snapshot",
  };
}

export interface GcDiagnosticResult {
  readonly rssBeforeMb: number;
  readonly rssAfterMb: number;
  readonly heapBeforeMb: number;
  readonly heapAfterMb: number;
  readonly rssDeltaMb: number;
  readonly heapDeltaMb: number;
}

export function runForcedGcDiagnostic(): GcDiagnosticResult | undefined {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") {
    return undefined;
  }
  const before = process.memoryUsage();
  gc();
  const after = process.memoryUsage();
  const rssBeforeMb = Math.round(before.rss / 1024 / 1024);
  const rssAfterMb = Math.round(after.rss / 1024 / 1024);
  const heapBeforeMb = Math.round(before.heapUsed / 1024 / 1024);
  const heapAfterMb = Math.round(after.heapUsed / 1024 / 1024);
  return {
    rssBeforeMb,
    rssAfterMb,
    heapBeforeMb,
    heapAfterMb,
    rssDeltaMb: rssAfterMb - rssBeforeMb,
    heapDeltaMb: heapAfterMb - heapBeforeMb,
  };
}

export interface MemorySurvivalConfig {
  readonly sustainedRssWarnMs: number;
  readonly minEvictionCount: number;
}

export interface MemorySurvivalState {
  readonly highRssSinceMs: number | undefined;
  readonly consecutiveLowEvictionWarnings: number;
}

export function createMemorySurvivalState(): MemorySurvivalState {
  return {
    highRssSinceMs: undefined,
    consecutiveLowEvictionWarnings: 0,
  };
}

export function recordMemoryPressureEviction(
  state: MemorySurvivalState,
  input: {
    readonly evicted: number;
    readonly rssAboveWarn: boolean;
    readonly nowMs: number;
    readonly config: MemorySurvivalConfig;
  },
): MemorySurvivalState {
  if (!input.rssAboveWarn) {
    return {
      highRssSinceMs: undefined,
      consecutiveLowEvictionWarnings: 0,
    };
  }

  const highRssSinceMs = state.highRssSinceMs ?? input.nowMs;
  const lowEviction = input.evicted < input.config.minEvictionCount;
  if (!lowEviction) {
    return {
      highRssSinceMs: undefined,
      consecutiveLowEvictionWarnings: 0,
    };
  }
  return {
    highRssSinceMs,
    consecutiveLowEvictionWarnings: state.consecutiveLowEvictionWarnings + 1,
  };
}

export function shouldTriggerSurvivalExit(
  state: MemorySurvivalState,
  input: {
    readonly nowMs: number;
    readonly config: MemorySurvivalConfig;
    readonly consecutiveWarningThreshold: number;
  },
): boolean {
  if (state.highRssSinceMs === undefined) {
    return false;
  }
  const sustainedMs = input.nowMs - state.highRssSinceMs;
  if (sustainedMs >= input.config.sustainedRssWarnMs) {
    return true;
  }
  return state.consecutiveLowEvictionWarnings >= input.consecutiveWarningThreshold;
}
