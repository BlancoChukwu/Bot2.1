import type { Address } from "viem";

export const SHADOW_DRIFT_ATTRIBUTION_TOP_N = 8;

export interface DriftBucketAccumulator {
  sampleCount: number;
  driftSumBps: number;
  maxDriftBps: number;
}

export interface AssetDriftAttribution {
  readonly asset: Address;
  readonly sampleCount: number;
  readonly meanDriftBps: number;
  readonly maxDriftBps: number;
}

export function emptyDriftBucket(): DriftBucketAccumulator {
  return {
    sampleCount: 0,
    driftSumBps: 0,
    maxDriftBps: 0,
  };
}

export function collectPositionAssets(position: {
  readonly collateral: ReadonlyMap<string, bigint>;
  readonly debt: ReadonlyMap<string, bigint>;
}): readonly Address[] {
  const assets: Address[] = [];
  for (const [assetKey, amount] of position.collateral) {
    if (amount > 0n) {
      assets.push(assetKey as Address);
    }
  }
  for (const [assetKey, amount] of position.debt) {
    if (amount > 0n) {
      assets.push(assetKey as Address);
    }
  }
  return assets;
}

export function recordAssetDrift(
  buckets: Map<string, DriftBucketAccumulator>,
  assets: readonly Address[],
  driftBps: number,
): void {
  const seen = new Set<string>();
  for (const asset of assets) {
    const key = asset.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const bucket = buckets.get(key) ?? emptyDriftBucket();
    bucket.sampleCount += 1;
    bucket.driftSumBps += driftBps;
    if (driftBps > bucket.maxDriftBps) {
      bucket.maxDriftBps = driftBps;
    }
    buckets.set(key, bucket);
  }
}

export function topAssetDriftAttribution(
  buckets: ReadonlyMap<string, DriftBucketAccumulator>,
  limit: number,
): readonly AssetDriftAttribution[] {
  return [...buckets.entries()]
    .map(([asset, bucket]) => ({
      asset: asset as Address,
      sampleCount: bucket.sampleCount,
      meanDriftBps: bucket.sampleCount === 0 ? 0 : bucket.driftSumBps / bucket.sampleCount,
      maxDriftBps: bucket.maxDriftBps,
    }))
    .sort((left, right) => (
      right.meanDriftBps - left.meanDriftBps
      || right.sampleCount - left.sampleCount
      || left.asset.localeCompare(right.asset)
    ))
    .slice(0, limit);
}
