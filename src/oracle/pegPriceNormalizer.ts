import type { Address } from "viem";
import { BASE_USDC, BASE_USDBC } from "./baseReserveAssets";

const WAD = 1_000_000_000_000_000_000n;
const BPS = 10_000n;
const MAX_PEG_DIVERGENCE_BPS = 50;

/** USDbC tracks USDC/USD Chainlink feed at 1:1 peg. */
export function pegUsdbcFromUsdcPrice(usdcNormalizedPriceWad18: bigint): bigint {
  return usdcNormalizedPriceWad18;
}

export function isUsdbcAsset(asset: Address): boolean {
  return asset.toLowerCase() === BASE_USDBC.toLowerCase();
}

export function pegReferenceAsset(asset: Address): Address | undefined {
  if (isUsdbcAsset(asset)) {
    return BASE_USDC;
  }
  return undefined;
}

export function pegDivergenceBps(pegPriceWad18: bigint, aavePriceBase8: bigint): number {
  if (aavePriceBase8 === 0n) {
    return Number(BPS);
  }
  const aaveWad18 = aavePriceBase8 * 10n ** 10n;
  const diff = pegPriceWad18 > aaveWad18 ? pegPriceWad18 - aaveWad18 : aaveWad18 - pegPriceWad18;
  return Number((diff * BPS) / aaveWad18);
}

export function isPegDivergenceAcceptable(pegPriceWad18: bigint, aavePriceBase8: bigint): boolean {
  return pegDivergenceBps(pegPriceWad18, aavePriceBase8) <= MAX_PEG_DIVERGENCE_BPS;
}

export { MAX_PEG_DIVERGENCE_BPS };
