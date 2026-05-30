import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Address } from "viem";

const liquidationParams = parseAbiParameters(
  "uint8 routeType,address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minCollateralOut,bool receiveAToken",
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
    0,
    route.collateralAsset,
    route.debtAsset,
    route.user,
    route.debtToCover,
    route.minCollateralOut,
    route.receiveAToken ?? false,
  ]);
}

export function encodeMoonwellRoute(route: EncodedLiquidationRoute): `0x${string}` {
  return encodeAbiParameters(liquidationParams, [
    1,
    route.collateralAsset,
    route.debtAsset,
    route.user,
    route.debtToCover,
    route.minCollateralOut,
    route.receiveAToken ?? false,
  ]);
}

export function encodeMorphoRoute(route: EncodedLiquidationRoute): `0x${string}` {
  return encodeAbiParameters(liquidationParams, [
    2,
    route.collateralAsset,
    route.debtAsset,
    route.user,
    route.debtToCover,
    route.minCollateralOut,
    route.receiveAToken ?? false,
  ]);
}
