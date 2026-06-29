import { MAX_UINT256 } from "../config/oracleBootstrap";
import { calculateHealthFactor } from "../protocols/aaveV3";
import type { HfResult, UserPosition } from "./localPositionModel";

const WAD = 1_000_000_000_000_000_000n;
const BPS = 10_000n;

/** Cap runaway per-reserve HF from dust-debt denominator collapse. */
export const HF_POLICY_CAP_WAD = 1_000n * WAD;

/** Prefer aggregate HF for tiering when HF is in the liquidation danger band. */
export const HF_DANGER_ZONE_MAX_WAD = (3n * WAD) / 2n;

/** Relative divergence threshold for high-confidence snapshot guard. */
export const HF_DIVERGENCE_RATIO_BPS = 5_000;

/** Minimum on-chain HF denominator when computing shadow drift (0.001 HF). */
export const MIN_ON_CHAIN_HF_WAD_FOR_DRIFT = 1_000_000_000_000_000n;

export const MAX_SHADOW_DRIFT_BPS = 10_000;

/** Aave base-currency dust debt threshold (8 decimals, ~$0.01). */
export const DUST_DEBT_BASE_THRESHOLD = 1_000_000n;

export function aggregateHfWad(position: UserPosition): bigint | undefined {
  if (
    position.lastTotalCollateralBase === undefined
    || position.lastTotalDebtBase === undefined
    || position.lastLiquidationThreshold === undefined
  ) {
    return undefined;
  }
  return calculateHealthFactor({
    totalCollateralBase: position.lastTotalCollateralBase,
    totalDebtBase: position.lastTotalDebtBase,
    currentLiquidationThreshold: position.lastLiquidationThreshold,
  });
}

export function isDangerZoneHf(hfWad: bigint): boolean {
  if (hfWad >= MAX_UINT256) {
    return false;
  }
  if (hfWad < HF_DANGER_ZONE_MAX_WAD) {
    return true;
  }
  const delta = hfWad > WAD ? hfWad - WAD : WAD - hfWad;
  return delta < WAD / 2n;
}

export function relativeDivergenceBps(baseline: bigint, proposed: bigint): number {
  if (baseline === 0n || baseline >= MAX_UINT256) {
    return 0;
  }
  const diff = baseline > proposed ? baseline - proposed : proposed - baseline;
  return Number((diff * BPS) / baseline);
}

export function capPerReserveHf(hfWad: bigint, position: UserPosition): bigint {
  if (hfWad > HF_POLICY_CAP_WAD) {
    return HF_POLICY_CAP_WAD;
  }
  const debtBase = position.lastTotalDebtBase;
  if (
    debtBase !== undefined
    && debtBase > 0n
    && debtBase < DUST_DEBT_BASE_THRESHOLD
    && hfWad > HF_DANGER_ZONE_MAX_WAD
  ) {
    return HF_POLICY_CAP_WAD;
  }
  return hfWad;
}

export function shouldRejectPerReserveOverwrite(
  position: UserPosition,
  proposedHf: bigint,
): boolean {
  if (position.confidence !== "high") {
    return false;
  }
  if (
    position.lastTotalDebtBase === undefined
    || position.lastTotalCollateralBase === undefined
  ) {
    return false;
  }
  return relativeDivergenceBps(position.cachedHfWad, proposedHf) > HF_DIVERGENCE_RATIO_BPS;
}

export function resolveEffectiveHfWad(position: UserPosition, perReserveHf: bigint): bigint {
  const capped = capPerReserveHf(perReserveHf, position);
  const aggregate = aggregateHfWad(position);

  if (aggregate !== undefined && isDangerZoneHf(aggregate)) {
    return aggregate;
  }

  if (shouldRejectPerReserveOverwrite(position, capped)) {
    return position.cachedHfWad;
  }

  return capped;
}

export function resolveHfFromResult(position: UserPosition, hfResult: HfResult): bigint | undefined {
  switch (hfResult.status) {
    case "price_incomplete":
    case "price_stale":
    case "error":
      return undefined;
    case "no_debt":
      if (position.lastTotalDebtBase !== undefined && position.lastTotalDebtBase > 0n) {
        const aggregate = aggregateHfWad(position);
        if (aggregate !== undefined) {
          return resolveEffectiveHfWad(position, aggregate);
        }
        return position.cachedHfWad;
      }
      return MAX_UINT256;
    case "ok":
      return resolveEffectiveHfWad(position, hfResult.hf);
    default: {
      const _exhaustive: never = hfResult;
      return _exhaustive;
    }
  }
}

export function computeShadowDriftBps(localHfWad: bigint, onChainHfWad: bigint): number {
  if (onChainHfWad === 0n) {
    return MAX_SHADOW_DRIFT_BPS;
  }
  const denom = onChainHfWad < MIN_ON_CHAIN_HF_WAD_FOR_DRIFT
    ? MIN_ON_CHAIN_HF_WAD_FOR_DRIFT
    : onChainHfWad;
  const diff = localHfWad > onChainHfWad ? localHfWad - onChainHfWad : onChainHfWad - localHfWad;
  const raw = Number((diff * BPS) / denom);
  return Math.min(raw, MAX_SHADOW_DRIFT_BPS);
}
