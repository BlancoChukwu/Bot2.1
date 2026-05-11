import { describe, expect, it } from "vitest";
import {
  AAVE_V3_BASE_FLASH_FEE_BPS,
  calculateFlashLoanArbitrageEV,
  calculateLiquidationEV,
  calculateLiquidationEv,
  MIN_PROFIT_THRESHOLD_BNB,
  MIN_PROFIT_THRESHOLD_WEI,
  simulateFullFlashLoanArbPath,
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

  it("calculates flash-loan arbitrage EV with fee, gas, and slippage buffers", () => {
    const ev = calculateFlashLoanArbitrageEV({
      amountIn: 1_000_000_000_000_000_000n,
      amountOutFinal: 1_030_000_000_000_000_000n,
      flashFeeBps: AAVE_V3_BASE_FLASH_FEE_BPS,
      gasEstimate: 500_000n,
      gasPrice: 1_000_000_000n,
      slippageBps: 100,
      minProfitThreshold: 1n,
    });

    expect(ev.flashFeeWei).toBe(500_000_000_000_000n);
    expect(ev.gasCostWei).toBe(500_000_000_000_000n);
    expect(ev.slippageBufferWei).toBe(10_300_000_000_000_000n);
    expect(ev.isProfitable).toBe(true);
    expect(MIN_PROFIT_THRESHOLD_BNB).toBe(150_000_000_000_000_000n);
  });

  it("returns unprofitable flash-loan EV when below threshold", () => {
    const ev = calculateFlashLoanArbitrageEV({
      amountIn: 1_000_000n,
      amountOutFinal: 1_001_000n,
      flashFeeBps: AAVE_V3_BASE_FLASH_FEE_BPS,
      gasEstimate: 500_000n,
      gasPrice: 1_000_000_000n,
      minProfitThreshold: MIN_PROFIT_THRESHOLD_WEI,
    });

    expect(ev.isProfitable).toBe(false);
    expect(ev.profitWei).toBe(0n);
  });

  it("simulates full flash-loan path and returns gas usage", async () => {
    const result = await simulateFullFlashLoanArbPath(
      {
        call: async () => undefined,
        estimateGas: async () => 444_000n,
      },
      {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        data: "0x1234",
        gasPrice: 1_000_000_000n,
      },
    );

    expect(result.success).toBe(true);
    expect(result.gasUsed).toBe(444_000n);
  });
});
