import { describe, expect, it } from "vitest";
import {
  LIQUIDATION_ROUTE_SNAPSHOT,
  planUniswapV3LiquidationRoute,
} from "../../src/config/uniswapV3LiquidationRoutes";
import type { LiquidationCandidate } from "../../src/protocols/aaveV3";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const WSTETH = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";

function candidate(
  collateralAsset: `0x${string}`,
  debtAsset: `0x${string}` = USDC,
): LiquidationCandidate {
  return {
    account: "0x1111111111111111111111111111111111111111",
    collateralAsset,
    debtAsset,
    debtToCover: 1_000_000_000n,
    repayValueUsd: 1_000,
    collateralReceivedWei: 1_050_000_000_000_000_000n,
    liquidationBonusBps: 500,
    closeFactorBps: 10_000,
    healthFactor: 900_000_000_000_000_000n,
  };
}

const launchFloor = {
  minDebtUsd: 50,
  minProfitUsd: 1.5,
  gasCostUsd: 0.0005,
  flashFeeBps: 5,
  slippageBps: 30,
} as const;

describe("planUniswapV3LiquidationRoute", () => {
  it("caps cbETH→USDC at 2.5% snapshot TVL and clears launch floors", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: candidate(CBETH),
      ...launchFloor,
    });

    expect(result.status).toBe("selected");
    if (result.status !== "selected") {
      throw new Error("expected selected");
    }
    expect(result.fee).toBe(3_000);
    expect(result.capped).toBe(true);
    expect(result.capBasis).toBe("snapshot");
    expect(result.effectiveTvlUsd).toBeCloseTo(5_324.912786, 6);
    expect(result.maxCollateralSwapUsd).toBeCloseTo(133.122819638, 8);
    expect(result.candidate.repayValueUsd).toBeCloseTo(126.783638, 6);
    expect(result.candidate.collateralReceivedWei).toBe(133_122_818_850_000_000n);
    expect(result.expectedProfitUsd).toBeCloseTo(5.894939, 6);
    expect(result.expectedProfitUsd).toBeGreaterThan(launchFloor.minProfitUsd);
    expect(result.candidate.repayValueUsd).toBeGreaterThan(launchFloor.minDebtUsd);
  });

  it("tightens the cap to live TVL when the pool has thinned since the snapshot", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: candidate(CBETH),
      ...launchFloor,
      livePoolTvlUsd: 4_000,
    });

    expect(result.status).toBe("selected");
    if (result.status !== "selected") {
      throw new Error("expected selected");
    }
    expect(result.capBasis).toBe("live");
    expect(result.effectiveTvlUsd).toBe(4_000);
    expect(result.maxCollateralSwapUsd).toBeCloseTo(100, 8);
    expect(result.candidate.repayValueUsd).toBeCloseTo(95.238095, 6);
    expect(result.expectedProfitUsd).toBeCloseTo(4.428071, 6);
  });

  it("rejects at execution time when live TVL drops the cap below the debt floor", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: candidate(CBETH),
      ...launchFloor,
      livePoolTvlUsd: 2_000,
    });
    expect(result).toEqual(expect.objectContaining({
      status: "rejected",
      reason: "thin_cap_unprofitable",
      capBasis: "live",
      effectiveTvlUsd: 2_000,
      cappedRepayValueUsd: expect.closeTo(47.619048, 6),
    }));
  });

  it("ignores a live TVL that is higher than the snapshot (keeps conservative cap)", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: candidate(CBETH),
      ...launchFloor,
      livePoolTvlUsd: 10_000,
    });
    expect(result.status).toBe("selected");
    if (result.status !== "selected") {
      throw new Error("expected selected");
    }
    expect(result.capBasis).toBe("snapshot");
    expect(result.effectiveTvlUsd).toBeCloseTo(5_324.912786, 6);
    expect(result.maxCollateralSwapUsd).toBeCloseTo(133.122819638, 8);
  });

  it("hard-fails wstETH→USDC because its cap cannot clear the $50 floor", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: candidate(WSTETH),
      ...launchFloor,
    });
    expect(result).toEqual({ status: "rejected", reason: "unmapped_pair" });
  });

  it("rejects a mapped thin route when its capped EV misses the profit floor", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: candidate(CBETH),
      ...launchFloor,
      minProfitUsd: 6,
    });
    expect(result).toEqual(expect.objectContaining({
      status: "rejected",
      reason: "thin_cap_unprofitable",
      cappedRepayValueUsd: expect.closeTo(126.783638, 6),
      expectedProfitUsd: expect.closeTo(5.894939, 6),
    }));
  });

  it("hard-fails an unknown pair", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: candidate("0x2222222222222222222222222222222222222222"),
      ...launchFloor,
    });
    expect(result).toEqual({ status: "rejected", reason: "unmapped_pair" });
  });

  it("uses a logged debug override only when explicitly supplied", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: candidate(CBETH),
      ...launchFloor,
      feeOverride: 500,
    });
    expect(result.status).toBe("selected");
    if (result.status === "selected") {
      expect(result.fee).toBe(500);
    }
  });

  it("pins snapshot provenance in code", () => {
    expect(LIQUIDATION_ROUTE_SNAPSHOT).toEqual(expect.objectContaining({
      validAsOfBlock: 48_903_239n,
      validAsOfIso: "2026-07-21T01:03:46.817Z",
      maxPoolTvlShareBps: 500,
      snapshotDriftHaircutBps: 5_000,
    }));
  });

  it("does not double-apply close factor when candidate already carries closeFactorBps", () => {
    const result = planUniswapV3LiquidationRoute({
      candidate: {
        ...candidate(CBETH),
        closeFactorBps: 5_000,
        debtToCover: 500_000_000n,
        repayValueUsd: 500,
        collateralReceivedWei: 525_000_000_000_000_000n,
      },
      ...launchFloor,
    });
    if (result.status === "selected") {
      expect(result.candidate.closeFactorBps).toBe(5_000);
      expect(result.candidate.repayValueUsd).toBeLessThanOrEqual(500);
      expect(result.candidate.debtToCover).toBeLessThanOrEqual(500_000_000n);
    }
  });
});
