import { describe, expect, it } from "vitest";
import { evaluateLiquidationProfitability } from "../../src/profitability/liquidationProfitabilityGate";

describe("evaluateLiquidationProfitability", () => {
  it("uses max(dynamicFloor, hardFloor) as effective gate", () => {
    const result = evaluateLiquidationProfitability({
      debtUsd: 80,
      liquidationBonusBps: 500,
      gasCostUsd: 2,
      flashFeeBps: 5,
      hardFloorUsd: 50,
    });
    expect(result.effectiveFloor).toBe(Math.max(result.dynamicFloor, 50));
    expect(result.pass).toBe(80 >= result.effectiveFloor);
  });

  it("fails sub-dollar dust even when hard floor is low", () => {
    const result = evaluateLiquidationProfitability({
      debtUsd: 1,
      liquidationBonusBps: 500,
      gasCostUsd: 5,
      flashFeeBps: 5,
      hardFloorUsd: 50,
    });
    expect(result.pass).toBe(false);
    expect(result.netProfitUsd).toBeLessThan(0);
  });
});
