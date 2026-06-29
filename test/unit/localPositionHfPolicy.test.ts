import { describe, expect, it } from "vitest";
import { MAX_UINT256 } from "../../src/config/oracleBootstrap";
import {
  HF_POLICY_CAP_WAD,
  aggregateHfWad,
  capPerReserveHf,
  computeShadowDriftBps,
  isDangerZoneHf,
  resolveEffectiveHfWad,
  resolveHfFromResult,
  shouldRejectPerReserveOverwrite,
} from "../../src/monitors/localPositionHfPolicy";
import type { UserPosition } from "../../src/monitors/localPositionModel";

const WAD = 1_000_000_000_000_000_000n;

function makePosition(overrides: Partial<UserPosition> = {}): UserPosition {
  return {
    account: "0x1111111111111111111111111111111111111111",
    collateral: new Map(),
    debt: new Map(),
    collateralIndexAtUpdate: new Map(),
    debtIndexAtUpdate: new Map(),
    cachedHfWad: 985_667_837_263_193_100n,
    confidence: "high",
    isFullySeeded: true,
    lastConfirmedBlock: 1n,
    lastActivityBlock: 1n,
    eModeCategoryId: 0,
    lastTotalCollateralBase: 51_444n,
    lastTotalDebtBase: 41_859n,
    lastLiquidationThreshold: 8_500n,
    ...overrides,
  };
}

describe("localPositionHfPolicy", () => {
  it("detects danger-zone HF near liquidation", () => {
    expect(isDangerZoneHf(985_667_837_263_193_100n)).toBe(true);
    expect(isDangerZoneHf(2n * WAD)).toBe(false);
    expect(isDangerZoneHf(1_200_000_000_000_000_000n)).toBe(true);
  });

  it("prefers aggregate HF in danger zone", () => {
    const position = makePosition();
    const aggregate = aggregateHfWad(position)!;
    const perReserveWrong = 4_620_000_000_000_000_000n;
    expect(resolveEffectiveHfWad(position, perReserveWrong)).toBe(aggregate);
  });

  it("uses aggregate when high-confidence divergence exceeds threshold outside danger zone", () => {
    const position = makePosition({
      cachedHfWad: 2_000_000_000_000_000_000n,
      lastTotalCollateralBase: 10_000n,
      lastTotalDebtBase: 4_000n,
      lastLiquidationThreshold: 8_500n,
    });
    const aggregate = aggregateHfWad(position)!;
    const perReserveWrong = 4_000_000_000_000_000_000n;
    expect(resolveEffectiveHfWad(position, perReserveWrong)).toBe(aggregate);
  });

  it("rejects >50% overwrite via shouldRejectPerReserveOverwrite", () => {
    const position = makePosition({
      cachedHfWad: 2_000_000_000_000_000_000n,
      lastTotalCollateralBase: 10_000n,
      lastTotalDebtBase: 4_000n,
      lastLiquidationThreshold: 8_500n,
    });
    const proposed = 4_000_000_000_000_000_000n;
    expect(shouldRejectPerReserveOverwrite(position, proposed)).toBe(true);
  });

  it("caps runaway per-reserve HF for dust debt", () => {
    const position = makePosition({ lastTotalDebtBase: 500_000n });
    const billionHf = 9_800_000_000n * WAD;
    expect(capPerReserveHf(billionHf, position)).toBe(HF_POLICY_CAP_WAD);
  });

  it("uses aggregate when per-reserve reports no debt but snapshot has debt", () => {
    const position = makePosition();
    const resolved = resolveHfFromResult(position, { status: "no_debt", hf: MAX_UINT256 });
    expect(resolved).toBe(aggregateHfWad(position));
  });

  it("caps shadow drift for dust on-chain HF denominators", () => {
    const local = 9_800_000_000n * WAD;
    const onChain = 990_000_000_000_000_000n;
    expect(computeShadowDriftBps(local, onChain)).toBe(10_000);
  });

  it("computes reasonable drift for aligned HF values", () => {
    const local = 990_000_000_000_000_000n;
    const onChain = 985_667_837_263_193_100n;
    const drift = computeShadowDriftBps(local, onChain);
    expect(drift).toBeGreaterThan(0);
    expect(drift).toBeLessThan(100);
  });
});
