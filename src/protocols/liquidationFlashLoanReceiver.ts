import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Address } from "viem";

/** Uniswap V3 fee tiers accepted by LiquidationFlashReceiver v5. */
export const UNISWAP_V3_FEE_TIERS = [100, 500, 3_000, 10_000] as const;
export type UniswapV3FeeTier = (typeof UNISWAP_V3_FEE_TIERS)[number];

const liquidationParams = parseAbiParameters(
  "uint8 routeType,address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minDebtOut,bool receiveAToken,uint24 fee",
);

export interface EncodedLiquidationRoute {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly user: Address;
  readonly debtToCover: bigint;
  /** Advisory / EV preview only (debt-asset wei). Never on-chain amountOutMinimum. */
  readonly minDebtOut: bigint;
  readonly receiveAToken?: boolean;
  /** Uniswap V3 fee tier — validated enum {100,500,3000,10000}. */
  readonly fee: UniswapV3FeeTier;
}

/** @deprecated Prefer EncodedLiquidationRoute.minDebtOut */
export type EncodedLiquidationRouteLegacy = Omit<EncodedLiquidationRoute, "minDebtOut" | "fee"> & {
  readonly minCollateralOut: bigint;
  readonly fee?: UniswapV3FeeTier;
};

export function assertUniswapV3FeeTier(fee: number): asserts fee is UniswapV3FeeTier {
  if (!(UNISWAP_V3_FEE_TIERS as readonly number[]).includes(fee)) {
    throw new Error(
      `Invalid Uniswap V3 fee tier ${fee}; expected one of ${UNISWAP_V3_FEE_TIERS.join(",")}`,
    );
  }
}

export function encodeLiquidationRoute(route: EncodedLiquidationRoute): `0x${string}` {
  assertUniswapV3FeeTier(route.fee);
  return encodeAbiParameters(liquidationParams, [
    0,
    route.collateralAsset,
    route.debtAsset,
    route.user,
    route.debtToCover,
    route.minDebtOut,
    route.receiveAToken ?? false,
    route.fee,
  ]);
}

export function encodeMoonwellRoute(route: EncodedLiquidationRoute): `0x${string}` {
  assertUniswapV3FeeTier(route.fee);
  return encodeAbiParameters(liquidationParams, [
    1,
    route.collateralAsset,
    route.debtAsset,
    route.user,
    route.debtToCover,
    route.minDebtOut,
    route.receiveAToken ?? false,
    route.fee,
  ]);
}

export function encodeMorphoRoute(route: EncodedLiquidationRoute): `0x${string}` {
  assertUniswapV3FeeTier(route.fee);
  return encodeAbiParameters(liquidationParams, [
    2,
    route.collateralAsset,
    route.debtAsset,
    route.user,
    route.debtToCover,
    route.minDebtOut,
    route.receiveAToken ?? false,
    route.fee,
  ]);
}
