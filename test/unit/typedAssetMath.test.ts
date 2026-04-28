import { describe, expect, it } from "vitest";
import {
  calculateNetProfit,
  convertToQuote,
  createAsset,
  createAssetAmount,
  meetsMinimumProfitMargin,
  subtractAssetAmounts,
} from "../../src/utils/typedAssetMath";

const usdc = createAsset({ symbol: "USDC", decimals: 6 });
const usd = createAsset({ symbol: "USD", decimals: 8 });
const weth = createAsset({ symbol: "WETH", decimals: 18 });

describe("typed asset math", () => {
  it("converts token units to a common quote currency using decimals-aware oracle prices", () => {
    const amount = createAssetAmount(usdc, 1_500_000n);
    const price = createAssetAmount(usd, 100_000_000n);

    expect(convertToQuote(amount, price).raw).toBe(150_000_000n);
  });

  it("calculates deterministic net profit after all cost components", () => {
    const revenue = createAssetAmount(usd, 5_000_000_000n);
    const debt = createAssetAmount(usd, 4_800_000_000n);
    const gas = createAssetAmount(usd, 25_000_000n);
    const flashLoanFee = createAssetAmount(usd, 4_000_000n);
    const swapCost = createAssetAmount(usd, 6_000_000n);

    const netProfit = calculateNetProfit({ revenue, debt, gas, flashLoanFee, swapCost });

    expect(netProfit.raw).toBe(165_000_000n);
  });

  it("enforces the 0.5 percent minimum margin using integer math", () => {
    const capitalAtRisk = createAssetAmount(usd, 10_000_000_000n);
    const belowThreshold = createAssetAmount(usd, 49_999_999n);
    const atThreshold = createAssetAmount(usd, 50_000_000n);

    expect(meetsMinimumProfitMargin({
      netProfit: belowThreshold,
      capitalAtRisk,
      minimumMarginBps: 50,
    })).toBe(false);
    expect(meetsMinimumProfitMargin({
      netProfit: atThreshold,
      capitalAtRisk,
      minimumMarginBps: 50,
    })).toBe(true);
  });

  it("rejects arithmetic across incompatible assets", () => {
    expect(() =>
      subtractAssetAmounts(createAssetAmount(usd, 1n), createAssetAmount(weth, 1n)),
    ).toThrow(/asset mismatch/i);
  });
});
