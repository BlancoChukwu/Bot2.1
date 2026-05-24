import { describe, expect, it } from "vitest";
import {
  computeDebtUsdFromWei,
  evaluateDustFilter,
  formatDustReasonLabel,
  isDustLiquidationCandidate,
} from "../../src/protocols/liquidationCandidateFilter";

describe("liquidationCandidateFilter", () => {
  it("computes debt USD from wei and 8-decimal oracle price", () => {
    const debtUsd = computeDebtUsdFromWei(2_000_000n, 6, 100_000_000n);
    expect(debtUsd).toBeCloseTo(2, 5);
  });

  it("flags dust below minimum debt and gas multiple", () => {
    expect(isDustLiquidationCandidate({ debtUsd: 5, minDebtUsd: 25, gasCostUsd: 4 })).toBe(true);
    expect(evaluateDustFilter({ debtUsd: 5, minDebtUsd: 25, gasCostUsd: 4 }).reason).toBe("below_min_debt");
    expect(isDustLiquidationCandidate({ debtUsd: 12, minDebtUsd: 10, gasCostUsd: 8 })).toBe(true);
    expect(isDustLiquidationCandidate({ debtUsd: 100, minDebtUsd: 25, gasCostUsd: 10 })).toBe(false);
  });

  it("formats dust reason labels for structured logs", () => {
    expect(formatDustReasonLabel("below_min_debt", 25)).toBe("below_MIN_LIQUIDATION_DEBT_USD(25)");
  });
});
