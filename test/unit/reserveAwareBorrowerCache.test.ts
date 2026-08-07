import { describe, expect, it } from "vitest";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";
import {
  ReserveAwareBorrowerCache,
  createReserveAwareCandidates,
  type BorrowerSnapshot,
} from "../../src/monitors/reserveAwareBorrowerCache";

const usd = createAsset({ symbol: "USD", decimals: 8 });
const usdc = createAsset({ symbol: "USDC", decimals: 6 });
const weth = createAsset({ symbol: "WETH", decimals: 18 });
const account = "0x0000000000000000000000000000000000000001";
const wethAddress = "0x4200000000000000000000000000000000000006";
const usdcAddress = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";

function liquidatableSnapshot(): BorrowerSnapshot {
  return {
    chain: "optimism",
    account,
    healthFactor: 900_000_000_000_000_000n,
    updatedAtMs: 1_000,
    reserves: [
      {
        assetAddress: wethAddress,
        asset: weth,
        collateralBalance: createAssetAmount(weth, 1_000_000_000_000_000_000n),
        variableDebt: createAssetAmount(weth, 0n),
        stableDebt: createAssetAmount(weth, 0n),
        priceInQuote: createAssetAmount(usd, 300_000_000_000n),
        usageAsCollateralEnabled: true,
        liquidationBonusBps: 500,
      },
      {
        assetAddress: usdcAddress,
        asset: usdc,
        collateralBalance: createAssetAmount(usdc, 0n),
        variableDebt: createAssetAmount(usdc, 1_500_000_000n),
        stableDebt: createAssetAmount(usdc, 500_000_000n),
        priceInQuote: createAssetAmount(usd, 100_000_000n),
        usageAsCollateralEnabled: false,
        liquidationBonusBps: 0,
      },
    ],
  };
}

describe("ReserveAwareBorrowerCache", () => {
  it("upserts borrower snapshots by chain and account", () => {
    const cache = new ReserveAwareBorrowerCache();

    cache.upsert(liquidatableSnapshot());

    expect(cache.get("optimism", account)?.reserves).toHaveLength(2);
    expect(cache.listAccounts("optimism")).toEqual([account]);
  });

  it("materializes candidates from real debt and collateral reserves using TypedAssetMath quotes", () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(liquidatableSnapshot());

    const candidates = createReserveAwareCandidates(cache, "optimism");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      account,
      collateralAsset: wethAddress,
      debtAsset: usdcAddress,
      debtToCover: 2_000_000_000n,
      liquidationBonusBps: 500,
      repayValueUsd: 2_000,
      closeFactorBps: 10_000,
    });
  });

  it("applies 50% close factor to large HF>0.95 liquidatable positions", () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert({
      ...liquidatableSnapshot(),
      healthFactor: 990_000_000_000_000_000n,
      reserves: [
        {
          assetAddress: wethAddress,
          asset: weth,
          collateralBalance: createAssetAmount(weth, 100_000_000_000_000_000_000n),
          variableDebt: createAssetAmount(weth, 0n),
          stableDebt: createAssetAmount(weth, 0n),
          priceInQuote: createAssetAmount(usd, 300_000_000_000n),
          usageAsCollateralEnabled: true,
          liquidationBonusBps: 500,
        },
        {
          assetAddress: usdcAddress,
          asset: usdc,
          collateralBalance: createAssetAmount(usdc, 0n),
          variableDebt: createAssetAmount(usdc, 15_000_000_000_000n),
          stableDebt: createAssetAmount(usdc, 0n),
          priceInQuote: createAssetAmount(usd, 100_000_000n),
          usageAsCollateralEnabled: false,
          liquidationBonusBps: 0,
        },
      ],
    });

    const candidates = createReserveAwareCandidates(cache, "optimism");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.closeFactorBps).toBe(5_000);
    expect(candidates[0]?.repayValueUsd).toBe(7_500_000);
    expect(candidates[0]?.debtToCover).toBe(7_500_000_000_000n);
  });

  it("does not emit candidates for healthy borrowers", () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert({ ...liquidatableSnapshot(), healthFactor: 1_100_000_000_000_000_000n });

    expect(createReserveAwareCandidates(cache, "optimism")).toEqual([]);
  });

  it("deduplicates repeated reserve updates for the same borrower", () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(liquidatableSnapshot());
    cache.upsert({ ...liquidatableSnapshot(), updatedAtMs: 2_000 });

    expect(cache.listAccounts("optimism")).toEqual([account]);
    expect(cache.get("optimism", account)?.updatedAtMs).toBe(2_000);
  });
});
