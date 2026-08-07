import type { Address } from "viem";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import type { UniswapV3FeeTier } from "../protocols/liquidationFlashLoanReceiver";
import type { LiquidationRejectReason } from "../types/liquidationRejectReason";
import { defaultCloseFactorBps, resolveAavePoolVersion } from "./aavePoolVersion";

export const LIQUIDATION_ROUTE_SNAPSHOT = {
  validAsOfBlock: 48_903_239n,
  validAsOfIso: "2026-07-21T01:03:46.817Z",
  source: "Base eth_call: UniswapV3Factory.getPool + pool token balances valued by Aave oracle",
  thinPairTvlThresholdUsd: 100_000,
  maxPoolTvlShareBps: 500,
  snapshotDriftHaircutBps: 5_000,
} as const;

interface LiquidationRoutePolicy {
  readonly fee: UniswapV3FeeTier;
  readonly snapshotTvlUsd: number;
  readonly thin: boolean;
}

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const CBETH = "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22";
const WSTETH = "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452";
const WEETH = "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a";
const AAVE = "0x63706e401c06ac8513145b7687a14804d17f814b";
const GHO = "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee";
const EURC = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";
const USDBC = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca";

/** Decimals for the mapped Base assets — avoids an ERC20 read on the hot path. */
const ASSET_DECIMALS: ReadonlyMap<string, number> = new Map([
  [WETH, 18],
  [USDC, 6],
  [CBBTC, 8],
  [CBETH, 18],
  [WSTETH, 18],
  [WEETH, 18],
  [AAVE, 18],
  [GHO, 18],
  [EURC, 6],
  [USDBC, 6],
]);

export function mappedAssetDecimals(asset: string): number | undefined {
  return ASSET_DECIMALS.get(asset.toLowerCase());
}

function pairKey(collateral: string, debt: string): string {
  return `${collateral.toLowerCase()}:${debt.toLowerCase()}`;
}

/** Max collateral (USD) sellable given a pool TVL, applying share ceiling + drift haircut. */
export function maxCollateralSwapUsdForTvl(tvlUsd: number): number {
  return tvlUsd
    * LIQUIDATION_ROUTE_SNAPSHOT.maxPoolTvlShareBps
    * (10_000 - LIQUIDATION_ROUTE_SNAPSHOT.snapshotDriftHaircutBps)
    / 100_000_000;
}

function thin(fee: UniswapV3FeeTier, snapshotTvlUsd: number): LiquidationRoutePolicy {
  return { fee, snapshotTvlUsd, thin: true };
}

function deep(fee: UniswapV3FeeTier, snapshotTvlUsd: number): LiquidationRoutePolicy {
  return { fee, snapshotTvlUsd, thin: false };
}

/**
 * Static Base routes ranked at LIQUIDATION_ROUTE_SNAPSHOT.validAsOfBlock.
 * Re-run `npm run refresh:liquidation-routes:base` before changing entries.
 * wstETH→USDC is intentionally unmapped: its ~$1.2k pool cannot clear the
 * production $50 debt floor under the approved 2.5%-of-snapshot cap.
 */
const ROUTES = new Map<string, LiquidationRoutePolicy>([
  [pairKey(WETH, USDC), deep(3_000, 109_621_834)],
  [pairKey(CBBTC, USDC), deep(500, 8_368_536)],
  [pairKey(CBBTC, WETH), deep(3_000, 11_039_417)],
  [pairKey(CBETH, USDC), thin(3_000, 5_324.912785534421)],
  [pairKey(CBETH, WETH), thin(500, 37_499.5858741152)],
  [pairKey(WSTETH, WETH), thin(100, 69_994.62981608014)],
  [pairKey(WEETH, WETH), thin(100, 39_887.137009766775)],
  [pairKey(AAVE, USDC), thin(3_000, 25_319.026540835624)],
  [pairKey(AAVE, WETH), deep(3_000, 168_864.29314838923)],
  [pairKey(GHO, USDC), thin(3_000, 54_148.576564881594)],
  [pairKey(EURC, USDC), thin(500, 70_650.80218112232)],
  [pairKey(USDBC, USDC), thin(100, 13_639.588038999998)],
]);

export interface MappedRoute {
  readonly fee: UniswapV3FeeTier;
  readonly snapshotTvlUsd: number;
  readonly thin: boolean;
}

/** Lookup for the runtime live-TVL probe: is this a mapped thin pair needing a live read? */
export function getMappedRoute(collateral: string, debt: string): MappedRoute | undefined {
  const policy = ROUTES.get(pairKey(collateral, debt));
  if (policy === undefined) {
    return undefined;
  }
  return { fee: policy.fee, snapshotTvlUsd: policy.snapshotTvlUsd, thin: policy.thin };
}

export type CapBasis = "snapshot" | "live";

export type LiquidationRoutePlan =
  | {
    readonly status: "selected";
    readonly candidate: LiquidationCandidate;
    readonly fee: UniswapV3FeeTier;
    readonly capped: boolean;
    readonly expectedProfitUsd: number;
    readonly maxCollateralSwapUsd?: number;
    readonly capBasis?: CapBasis;
    readonly effectiveTvlUsd?: number;
  }
  | {
    readonly status: "rejected";
    readonly reason: Extract<LiquidationRejectReason, "unmapped_pair" | "thin_cap_unprofitable">;
    readonly fee?: UniswapV3FeeTier;
    readonly cappedRepayValueUsd?: number;
    readonly expectedProfitUsd?: number;
    readonly maxCollateralSwapUsd?: number;
    readonly capBasis?: CapBasis;
    readonly effectiveTvlUsd?: number;
  };

export interface LiquidationRoutePlanInput {
  readonly candidate: LiquidationCandidate;
  readonly minDebtUsd: number;
  readonly minProfitUsd: number;
  readonly gasCostUsd: number;
  readonly flashFeeBps: number;
  readonly slippageBps: number;
  readonly feeOverride?: UniswapV3FeeTier;
  /**
   * Live pool TVL (USD) read on-chain at execution time. When provided for a
   * thin pair the cap is sized against `min(snapshot, live)`, so a stale-high
   * snapshot can never oversize the swap. Omit for non-thin pairs / replay.
   */
  readonly livePoolTvlUsd?: number;
}

export function planUniswapV3LiquidationRoute(
  input: LiquidationRoutePlanInput,
): LiquidationRoutePlan {
  const policy = ROUTES.get(pairKey(input.candidate.collateralAsset, input.candidate.debtAsset));
  if (policy === undefined) {
    return { status: "rejected", reason: "unmapped_pair" };
  }

  const fee = input.feeOverride ?? policy.fee;
  const eligible = eligibleCandidate(input.candidate);
  if (!policy.thin) {
    return selected(eligible, fee, false, input);
  }
  return planThinRoute(eligible, policy.snapshotTvlUsd, fee, input);
}

function planThinRoute(
  eligible: LiquidationCandidate,
  snapshotTvlUsd: number,
  fee: UniswapV3FeeTier,
  input: LiquidationRoutePlanInput,
): LiquidationRoutePlan {
  const useLive = input.livePoolTvlUsd !== undefined && input.livePoolTvlUsd < snapshotTvlUsd;
  const effectiveTvlUsd = useLive ? input.livePoolTvlUsd! : snapshotTvlUsd;
  const capBasis: CapBasis = useLive ? "live" : "snapshot";
  const maxCollateralSwapUsd = maxCollateralSwapUsdForTvl(effectiveTvlUsd);

  const bonusMultiplier = 1 + input.candidate.liquidationBonusBps / 10_000;
  const debtCapUsd = maxCollateralSwapUsd / bonusMultiplier;
  const cappedRepayValueUsd = Math.min(eligible.repayValueUsd, debtCapUsd);
  const capped = capCandidate(eligible, cappedRepayValueUsd);
  const expectedProfitUsd = estimateNetProfit(cappedRepayValueUsd, input);
  if (cappedRepayValueUsd < input.minDebtUsd || expectedProfitUsd < input.minProfitUsd) {
    return {
      status: "rejected",
      reason: "thin_cap_unprofitable",
      fee,
      cappedRepayValueUsd,
      expectedProfitUsd,
      maxCollateralSwapUsd,
      capBasis,
      effectiveTvlUsd,
    };
  }
  return {
    status: "selected",
    candidate: capped,
    fee,
    capped: capped.debtToCover < eligible.debtToCover,
    expectedProfitUsd,
    maxCollateralSwapUsd,
    capBasis,
    effectiveTvlUsd,
  };
}

/**
 * Apply close-factor sizing only when the candidate has not already been capped.
 * If closeFactorBps is set, return as-is — double-haircut is impossible.
 */
export function eligibleCandidate(candidate: LiquidationCandidate): LiquidationCandidate {
  if (candidate.closeFactorBps !== undefined) {
    return candidate;
  }
  const closeFactorBps = defaultCloseFactorBps(resolveAavePoolVersion(), candidate.healthFactor);
  const debtToCover = (candidate.debtToCover * BigInt(closeFactorBps)) / 10_000n;
  return {
    ...candidate,
    debtToCover,
    repayValueUsd: candidate.repayValueUsd * closeFactorBps / 10_000,
    ...(candidate.collateralReceivedWei === undefined
      ? {}
      : {
        collateralReceivedWei:
          (candidate.collateralReceivedWei * BigInt(closeFactorBps)) / 10_000n,
      }),
    closeFactorBps,
  };
}

function capCandidate(
  candidate: LiquidationCandidate,
  cappedRepayValueUsd: number,
): LiquidationCandidate {
  if (candidate.repayValueUsd <= cappedRepayValueUsd) {
    return candidate;
  }
  const ratioScale = 1_000_000_000n;
  const ratio = BigInt(Math.floor(
    cappedRepayValueUsd / candidate.repayValueUsd * Number(ratioScale),
  ));
  return {
    ...candidate,
    debtToCover: (candidate.debtToCover * ratio) / ratioScale,
    repayValueUsd: cappedRepayValueUsd,
    ...(candidate.collateralReceivedWei === undefined
      ? {}
      : {
        collateralReceivedWei:
          (candidate.collateralReceivedWei * ratio) / ratioScale,
      }),
  };
}

function estimateNetProfit(
  repayValueUsd: number,
  input: LiquidationRoutePlanInput,
): number {
  const netBps =
    input.candidate.liquidationBonusBps - input.flashFeeBps - input.slippageBps;
  return repayValueUsd * netBps / 10_000 - input.gasCostUsd;
}

function selected(
  candidate: LiquidationCandidate,
  fee: UniswapV3FeeTier,
  capped: boolean,
  input: LiquidationRoutePlanInput,
): LiquidationRoutePlan {
  return {
    status: "selected",
    candidate,
    fee,
    capped,
    expectedProfitUsd: estimateNetProfit(candidate.repayValueUsd, input),
  };
}
