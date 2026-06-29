export interface LogRateLimiterConfig {
  readonly intervalMs: number;
  readonly maxKeys?: number;
}

export interface HfPriceGapSummary {
  readonly windowSec: number;
  readonly gaps: readonly {
    readonly asset: string;
    readonly skipCount: number;
    readonly affectedPositions: number;
  }[];
  readonly totalSkips: number;
}

interface GapBucket {
  skipCount: number;
  readonly accounts: Set<string>;
}

export class HfPriceGapAggregator {
  private windowStartMs = Date.now();
  private totalSkips = 0;
  private readonly gaps = new Map<string, GapBucket>();
  private readonly windowSec: number;

  public constructor(config: { readonly windowSec: number }) {
    this.windowSec = config.windowSec;
  }

  public record(account: string, missingAssets: readonly { toString(): string }[]): HfPriceGapSummary | undefined {
    this.totalSkips += 1;
    const accountKey = account.toLowerCase();
    for (const asset of missingAssets) {
      const assetKey = asset.toString().toLowerCase();
      let bucket = this.gaps.get(assetKey);
      if (bucket === undefined) {
        bucket = { skipCount: 0, accounts: new Set() };
        this.gaps.set(assetKey, bucket);
      }
      bucket.skipCount += 1;
      bucket.accounts.add(accountKey);
    }

    const elapsedMs = Date.now() - this.windowStartMs;
    if (this.windowSec > 0 && elapsedMs < this.windowSec * 1_000) {
      return undefined;
    }
    return this.flush();
  }

  public flush(): HfPriceGapSummary {
    const summary: HfPriceGapSummary = {
      windowSec: this.windowSec,
      totalSkips: this.totalSkips,
      gaps: [...this.gaps.entries()].map(([asset, bucket]) => ({
        asset,
        skipCount: bucket.skipCount,
        affectedPositions: bucket.accounts.size,
      })),
    };
    this.windowStartMs = Date.now();
    this.totalSkips = 0;
    this.gaps.clear();
    return summary;
  }
}

interface BucketState {
  count: number;
  lastFlushMs: number;
  sampleKeys: string[];
}

export class LogRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly intervalMs: number;
  private readonly maxKeys: number;

  public constructor(config: LogRateLimiterConfig) {
    this.intervalMs = config.intervalMs;
    this.maxKeys = config.maxKeys ?? 64;
  }

  public record(key: string, detailKey?: string): { shouldLog: boolean; suppressed: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        this.evictOldestBucket();
      }
      bucket = { count: 0, lastFlushMs: now, sampleKeys: [] };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (detailKey !== undefined && bucket.sampleKeys.length < 5 && !bucket.sampleKeys.includes(detailKey)) {
      bucket.sampleKeys.push(detailKey);
    }

    if (now - bucket.lastFlushMs >= this.intervalMs) {
      const suppressed = bucket.count - 1;
      bucket.count = 1;
      bucket.lastFlushMs = now;
      bucket.sampleKeys = detailKey === undefined ? [] : [detailKey];
      return { shouldLog: true, suppressed };
    }

    return { shouldLog: false, suppressed: 0 };
  }

  public flushSummary(key: string): {
    readonly total: number;
    readonly sampleKeys: readonly string[];
    readonly windowMs: number;
  } | undefined {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.count === 0) {
      return undefined;
    }
    const summary = {
      total: bucket.count,
      sampleKeys: [...bucket.sampleKeys],
      windowMs: Date.now() - bucket.lastFlushMs,
    };
    bucket.count = 0;
    bucket.sampleKeys = [];
    bucket.lastFlushMs = Date.now();
    return summary;
  }

  private evictOldestBucket(): void {
    let oldestKey: string | undefined;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastFlushMs < oldestMs) {
        oldestMs = bucket.lastFlushMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.buckets.delete(oldestKey);
    }
  }
}
