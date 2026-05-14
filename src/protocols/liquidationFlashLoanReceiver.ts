import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Address } from "viem";

const liquidationParams = parseAbiParameters(
  "address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minCollateralOut,bool receiveAToken",
);

export interface EncodedLiquidationRoute {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly user: Address;
  readonly debtToCover: bigint;
  readonly minCollateralOut: bigint;
  readonly receiveAToken?: boolean;
}

export function encodeLiquidationRoute(route: EncodedLiquidationRoute): `0x${string}` {
  return encodeAbiParameters(liquidationParams, [
    route.collateralAsset,
    route.debtAsset,
    route.user,
    route.debtToCover,
    route.minCollateralOut,
    route.receiveAToken ?? false,
  ]);
}
