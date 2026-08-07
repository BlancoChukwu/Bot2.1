import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_NET_PROFIT_USD,
  compareCloseFactorEv,
  evaluateLiquidationProfitability,
} from "../../src/profitability/liquidationProfitabilityGate";

describe("evaluateLiquidationProfitability", () => {
  it("uses max(dynamicFloor, hardFloor) as effective debt gate", () => {
    const result = evaluateLiquidationProfitability({
      debtUsd: 80,
      liquidationBonusBps: 500,
      gasCostUsd: 2,
      flashFeeBps: 5,
      hardFloorUsd: 50,
      minNetProfitUsd: 1,
      minNetProfitGasMultiple: 0,
    });
    expect(result.effectiveFloor).toBe(Math.max(result.dynamicFloor, 50));
    expect(result.pass).toBe(80 >= result.effectiveFloor && result.netProfitPass);
  });

  it("fails sub-dollar dust even when hard floor is low", () => {
    const result = evaluateLiquidationProfitability({
      debtUsd: 1,
      liquidationBonusBps: 500,
      gasCostUsd: 5,
      flashFeeBps: 5,
      hardFloorUsd: 50,
      minNetProfitUsd: 1,
      minNetProfitGasMultiple: 0,
    });
    expect(result.pass).toBe(false);
    expect(result.netProfitUsd).toBeLessThan(0);
  });

  it("requires net profit ≥ max($45, 2× gas) by default", () => {
    const result = evaluateLiquidationProfitability({
      debtUsd: 2_000,
      liquidationBonusBps: 500,
      gasCostUsd: 10,
      flashFeeBps: 5,
      hardFloorUsd: 50,
    });
    expect(result.minNetProfitUsd).toBe(DEFAULT_MIN_NET_PROFIT_USD);
    expect(result.netProfitFloorUsd).toBe(Math.max(45, 20));
    // bonus = 100, gas = 10, flash ≈ 1 → net ≈ 89 → pass
    expect(result.netProfitPass).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("fails when net profit is below 2× gas even if debt floor passes", () => {
    const result = evaluateLiquidationProfitability({
      debtUsd: 200,
      liquidationBonusBps: 500,
      gasCostUsd: 8,
      flashFeeBps: 5,
      hardFloorUsd: 50,
      minNetProfitUsd: 45,
      minNetProfitGasMultiple: 2,
    });
    // bonus = 10, gas = 8, flash ≈ 0.1 → net ≈ 1.9 < max(45, 16)
    expect(result.netProfitPass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("whale EV uses capped debt (not 2× full-debt EV) when CF=5000", () => {
    const shared = {
      liquidationBonusBps: 500,
      gasCostUsd: 10,
      flashFeeBps: 9,
      hardFloorUsd: 50,
      minNetProfitUsd: 45,
      minNetProfitGasMultiple: 2,
    };
    const capped = evaluateLiquidationProfitability({ ...shared, debtUsd: 7_500_000 });
    const uncapped = evaluateLiquidationProfitability({ ...shared, debtUsd: 15_000_000 });
    expect(capped.netProfitUsd).toBeLessThan(uncapped.netProfitUsd * 0.6);
    expect(capped.netProfitUsd).toBeCloseTo(7_500_000 * 0.05 - 10 - 7_500_000 * 0.0009, 0);

    const compare = compareCloseFactorEv({
      ...shared,
      cappedDebtUsd: 7_500_000,
      closeFactorBps: 5_000,
    });
    expect(compare.evCapped).toBe(capped.netProfitUsd);
    expect(compare.evUncapped).toBe(uncapped.netProfitUsd);
    expect(compare.evDeltaUsd).toBeCloseTo(uncapped.netProfitUsd - capped.netProfitUsd, 6);
  });
});
