import { describe, expect, it } from "vitest";
import {
  filterHealthyPegAssetsFromGapList,
  resolveEffectiveAssetPriceWad18,
  shouldRelaxFreshnessForHealthyPeg,
} from "../../src/oracle/healthyPegAsset";
import { BASE_USDC, BASE_USDBC } from "../../src/oracle/baseReserveAssets";

const NOW_SEC = 1_700_000_000;
const USDC_NORMALIZED = 1_000_000_000_000_000_000n;
const USDC_FEED = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B" as const;

describe("healthyPegAsset", () => {
  it("relaxes USDbC when USDC chainlink feed is fresh", () => {
    const input = {
      prices: new Map<string, bigint>([[BASE_USDC.toLowerCase(), USDC_NORMALIZED]]),
      feedStates: new Map([
        [
          BASE_USDC.toLowerCase(),
          {
            updatedAt: NOW_SEC - 100,
            feedAddress: USDC_FEED,
            source: "chainlink" as const,
          },
        ],
      ]),
      nowSec: NOW_SEC,
    };

    expect(shouldRelaxFreshnessForHealthyPeg(BASE_USDBC, input)).toBe(true);
    expect(resolveEffectiveAssetPriceWad18(BASE_USDBC, input)).toBe(USDC_NORMALIZED);
  });

  it("does not relax USDbC when USDC feed is stale", () => {
    const input = {
      prices: new Map<string, bigint>([[BASE_USDC.toLowerCase(), USDC_NORMALIZED]]),
      feedStates: new Map([
        [
          BASE_USDC.toLowerCase(),
          {
            updatedAt: NOW_SEC - 200_000,
            feedAddress: USDC_FEED,
            source: "chainlink" as const,
          },
        ],
      ]),
      nowSec: NOW_SEC,
    };

    expect(shouldRelaxFreshnessForHealthyPeg(BASE_USDBC, input)).toBe(false);
    expect(resolveEffectiveAssetPriceWad18(BASE_USDBC, input)).toBeUndefined();
  });

  it("filters USDbC from gap asset lists when reference is healthy", () => {
    const input = {
      prices: new Map<string, bigint>([[BASE_USDC.toLowerCase(), USDC_NORMALIZED]]),
      feedStates: new Map([
        [
          BASE_USDC.toLowerCase(),
          {
            updatedAt: NOW_SEC,
            feedAddress: USDC_FEED,
            source: "chainlink" as const,
          },
        ],
      ]),
      nowSec: NOW_SEC,
    };
    const weth = "0x4200000000000000000000000000000000000006" as const;

    expect(filterHealthyPegAssetsFromGapList([BASE_USDBC, weth], input)).toEqual([weth]);
  });
});
