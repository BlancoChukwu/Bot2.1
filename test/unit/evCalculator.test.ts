import { describe, expect, it } from "vitest";
import {
  calculateLiquidationEV,
  calculateLiquidationEv,
  MIN_PROFIT_THRESHOLD_WEI,
} from "../../src/utils/evCalculator";

describe("calculateLiquidationEv", () => {
  it("calculates positive ETH-denominated EV after bonus, gas, and slippage", () => {
    const ev = calculateLiquidationEV(
      1_000_000_000_000_000_000n,
      1_000_000_000_000_000_000n,
      500,
      1_000_000n,
      1_000_000_000n,
    );

    expect(ev.profitWei).toBe(39_000_000_000_000_000n);
    expect(ev.isProfitable).toBe(true);
    expect(MIN_PROFIT_THRESHOLD_WEI).toBe(10_000_000_000_000_000n);
  });

  it("returns zero profit for negative EV opportunities", () => {
    const ev = calculateLiquidationEV(
      1_000_000_000_000_000_000n,
      1_000_000_000_000_000_000n,
      50,
      10_000_000n,
      1_000_000_000n,
    );

    expect(ev.profitWei).toBe(0n);
    expect(ev.isProfitable).toBe(false);
  });

  it("returns profitable when collateral bonus exceeds debt, gas, and safety margin", () => {
    const ev = calculateLiquidationEv({
      repayValueUsd: 1_000,
      liquidationBonusBps: 500,
      gasCostUsd: 4,
      slippageBps: 50,
      minProfitUsd: 10,
    });

    expect(ev.expectedProfitUsd).toBeCloseTo(41);
    expect(ev.isProfitable).toBe(true);
  });

  it("rejects candidates below the configured minimum profit", () => {
    const ev = calculateLiquidationEv({
      repayValueUsd: 1_000,
      liquidationBonusBps: 50,
      gasCostUsd: 3,
      slippageBps: 20,
      minProfitUsd: 10,
    });

    expect(ev.isProfitable).toBe(false);
  });

  it("rejects invalid negative inputs explicitly", () => {
    expect(() =>
      calculateLiquidationEv({
        repayValueUsd: -1,
        liquidationBonusBps: 500,
        gasCostUsd: 4,
        slippageBps: 50,
        minProfitUsd: 10,
      }),
    ).toThrow(/repayValueUsd/);
  });
});
