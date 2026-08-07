/** Pool version for close-factor resolution (mirrors AavePoolVersion without circular import). */
export type CloseFactorPoolVersion = "v3" | "v4";

/** Aave V3 CLOSE_FACTOR_HF_THRESHOLD — inclusive at 0.95 WAD. */
export const CLOSE_FACTOR_HF_THRESHOLD_WAD = 950_000_000_000_000_000n;

/** Aave V3 MIN_BASE_CURRENCY_FOR_FULL_CLOSE_FACTOR (~$2000). */
export const MIN_BASE_CURRENCY_USD = 2_000;

export const CLOSE_FACTOR_FULL_BPS = 10_000;
export const CLOSE_FACTOR_PARTIAL_BPS = 5_000;

export interface ResolveCloseFactorInput {
  readonly healthFactorWad: bigint;
  readonly collateralUsd: number;
  readonly debtUsd: number;
  readonly poolVersion?: CloseFactorPoolVersion;
}

/**
 * Aave V3 close-factor SSoT:
 * 100% if HF ≤ 0.95 OR collateralUsd < $2000 OR debtUsd < $2000; else 50%.
 * v4: not yet modeled — returns 100%.
 */
export function resolveCloseFactorBps(input: ResolveCloseFactorInput): number {
  const poolVersion = input.poolVersion ?? "v3";
  if (poolVersion === "v4") {
    return CLOSE_FACTOR_FULL_BPS;
  }
  if (
    input.healthFactorWad <= CLOSE_FACTOR_HF_THRESHOLD_WAD
    || input.collateralUsd < MIN_BASE_CURRENCY_USD
    || input.debtUsd < MIN_BASE_CURRENCY_USD
  ) {
    return CLOSE_FACTOR_FULL_BPS;
  }
  return CLOSE_FACTOR_PARTIAL_BPS;
}

/** Scale a full (uncapped) debt wei amount by close-factor bps. */
export function applyCloseFactorToDebtWei(debtWei: bigint, closeFactorBps: number): bigint {
  return (debtWei * BigInt(closeFactorBps)) / 10_000n;
}

/** Scale a full (uncapped) USD amount by close-factor bps. */
export function applyCloseFactorToUsd(debtUsd: number, closeFactorBps: number): number {
  return debtUsd * closeFactorBps / 10_000;
}

/**
 * Recover uncapped debt USD when the candidate already carries capped debt + closeFactorBps.
 */
export function uncappedDebtUsdFromCapped(cappedDebtUsd: number, closeFactorBps: number | undefined): number {
  if (closeFactorBps === undefined || closeFactorBps <= 0 || closeFactorBps >= CLOSE_FACTOR_FULL_BPS) {
    return cappedDebtUsd;
  }
  return cappedDebtUsd * CLOSE_FACTOR_FULL_BPS / closeFactorBps;
}
