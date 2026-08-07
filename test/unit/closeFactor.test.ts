import { describe, expect, it } from "vitest";
import {
  CLOSE_FACTOR_FULL_BPS,
  CLOSE_FACTOR_HF_THRESHOLD_WAD,
  CLOSE_FACTOR_PARTIAL_BPS,
  resolveCloseFactorBps,
} from "../../src/config/closeFactor";

describe("resolveCloseFactorBps", () => {
  it("returns 10000 at HF = 0.95 exactly (inclusive boundary)", () => {
    expect(resolveCloseFactorBps({
      healthFactorWad: CLOSE_FACTOR_HF_THRESHOLD_WAD,
      collateralUsd: 15_000_000,
      debtUsd: 15_000_000,
    })).toBe(CLOSE_FACTOR_FULL_BPS);
  });

  it("returns 10000 when HF is 0.94", () => {
    expect(resolveCloseFactorBps({
      healthFactorWad: 940_000_000_000_000_000n,
      collateralUsd: 15_000_000,
      debtUsd: 15_000_000,
    })).toBe(CLOSE_FACTOR_FULL_BPS);
  });

  it("returns 5000 for a $15M whale at HF 1.015", () => {
    expect(resolveCloseFactorBps({
      healthFactorWad: 1_015_000_000_000_000_000n,
      collateralUsd: 20_000_000,
      debtUsd: 15_000_000,
    })).toBe(CLOSE_FACTOR_PARTIAL_BPS);
  });

  it("returns 10000 when debtUsd < 2000 even if HF > 0.95", () => {
    expect(resolveCloseFactorBps({
      healthFactorWad: 990_000_000_000_000_000n,
      collateralUsd: 10_000,
      debtUsd: 1_999,
    })).toBe(CLOSE_FACTOR_FULL_BPS);
  });

  it("returns 10000 when collateralUsd < 2000 even if HF > 0.95", () => {
    expect(resolveCloseFactorBps({
      healthFactorWad: 990_000_000_000_000_000n,
      collateralUsd: 1_500,
      debtUsd: 10_000,
    })).toBe(CLOSE_FACTOR_FULL_BPS);
  });

  it("returns 10000 for v4 regardless of HF", () => {
    expect(resolveCloseFactorBps({
      healthFactorWad: 1_015_000_000_000_000_000n,
      collateralUsd: 15_000_000,
      debtUsd: 15_000_000,
      poolVersion: "v4",
    })).toBe(CLOSE_FACTOR_FULL_BPS);
  });
});
