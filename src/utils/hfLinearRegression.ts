export interface HfRegressionSample {
  readonly atMs: number;
  readonly healthFactor: number;
}

export interface HfRegressionResult {
  readonly slopePerMs: number;
  readonly rSquared: number;
  readonly projectedHfAtMs: (targetMs: number) => number;
}

/**
 * Ordinary least-squares line through HF samples indexed by time (ms).
 * Returns slope (HF units per ms) and R².
 */
export function linearRegressionHf(samples: readonly HfRegressionSample[]): HfRegressionResult | undefined {
  const n = samples.length;
  if (n < 2) {
    return undefined;
  }
  const t0 = samples[0]!.atMs;
  let sumT = 0;
  let sumH = 0;
  let sumTT = 0;
  let sumTH = 0;
  for (const sample of samples) {
    const t = sample.atMs - t0;
    sumT += t;
    sumH += sample.healthFactor;
    sumTT += t * t;
    sumTH += t * sample.healthFactor;
  }
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) {
    return undefined;
  }
  const slope = (n * sumTH - sumT * sumH) / denom;
  const intercept = (sumH - slope * sumT) / n;
  const meanH = sumH / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const sample of samples) {
    const t = sample.atMs - t0;
    const predicted = intercept + slope * t;
    ssTot += (sample.healthFactor - meanH) ** 2;
    ssRes += (sample.healthFactor - predicted) ** 2;
  }
  const rSquared = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
  return {
    slopePerMs: slope,
    rSquared,
    projectedHfAtMs: (targetMs: number) => intercept + slope * (targetMs - t0),
  };
}

/** Project HF at `blocksAhead` assuming ~2s block time from last sample timestamp. */
export function projectHfBlocksAhead(
  regression: HfRegressionResult,
  lastSample: HfRegressionSample,
  blocksAhead: number,
  blockTimeMs = 2_000,
): number {
  const targetMs = lastSample.atMs + blocksAhead * blockTimeMs;
  return regression.projectedHfAtMs(targetMs);
}
