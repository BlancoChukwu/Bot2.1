import type { Address } from "viem";
import { FEED_HEARTBEATS } from "../config/oracleBootstrap";
import { BASE_USDC, BASE_USDBC } from "./baseReserveAssets";
import {
  isUsdbcAsset,
  pegUsdbcFromUsdcPrice,
  resolvePegPriceWad18,
} from "./pegPriceNormalizer";

export interface PegFeedState {
  readonly updatedAt: number;
  readonly feedAddress: Address;
  readonly source?: "chainlink" | "aave" | "peg";
}

export interface PegReferenceHealthInput {
  readonly prices: ReadonlyMap<string, bigint>;
  readonly feedStates: ReadonlyMap<string, PegFeedState>;
  readonly nowSec: number;
}

/** True when a peg asset (USDbC) can inherit a fresh USDC reference price locally. */
export function shouldRelaxFreshnessForHealthyPeg(
  asset: Address,
  input: PegReferenceHealthInput,
): boolean {
  if (!isUsdbcAsset(asset)) {
    return false;
  }
  const usdcKey = BASE_USDC.toLowerCase();
  const usdcPrice = input.prices.get(usdcKey);
  if (usdcPrice === undefined || usdcPrice <= 1n) {
    return false;
  }
  const usdcFeed = input.feedStates.get(usdcKey);
  if (usdcFeed === undefined) {
    return true;
  }
  if (usdcFeed.source === "aave" || usdcFeed.source === "peg") {
    return true;
  }
  const heartbeat = FEED_HEARTBEATS[usdcFeed.feedAddress.toLowerCase()] ?? 3600;
  return input.nowSec - usdcFeed.updatedAt <= heartbeat * 1.5;
}

export function resolveHealthyPegPriceWad18(
  asset: Address,
  input: PegReferenceHealthInput,
): bigint | undefined {
  if (!shouldRelaxFreshnessForHealthyPeg(asset, input)) {
    return undefined;
  }
  return resolvePegPriceWad18(asset, input.prices);
}

export function resolveEffectiveAssetPriceWad18(
  asset: Address,
  input: PegReferenceHealthInput,
): bigint | undefined {
  const assetKey = asset.toLowerCase();
  const direct = input.prices.get(assetKey);
  if (direct !== undefined && direct > 1n) {
    return direct;
  }
  return resolveHealthyPegPriceWad18(asset, input);
}

export function filterHealthyPegAssetsFromGapList(
  missingAssets: readonly Address[],
  input: PegReferenceHealthInput,
): Address[] {
  return missingAssets.filter((asset) => !shouldRelaxFreshnessForHealthyPeg(asset, input));
}

export function pegUsdbcPriceFromHealthyReference(input: PegReferenceHealthInput): bigint | undefined {
  if (!shouldRelaxFreshnessForHealthyPeg(BASE_USDBC, input)) {
    return undefined;
  }
  const usdcPrice = input.prices.get(BASE_USDC.toLowerCase());
  if (usdcPrice === undefined || usdcPrice <= 1n) {
    return undefined;
  }
  return pegUsdbcFromUsdcPrice(usdcPrice);
}
