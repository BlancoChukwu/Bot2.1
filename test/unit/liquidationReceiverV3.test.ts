import { describe, expect, it } from "vitest";
import {
  RECEIVER_V3_LAYOUT_ID,
  RECEIVER_V3_VERSION,
  assertReceiverV3Identity,
  decodeLiquidationReceiverV3Params,
  encodeLiquidationReceiverV3Params,
} from "../../src/executors/liquidationReceiverV3";

const sample = {
  collateral: "0x4200000000000000000000000000000000000006" as const,
  debt: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
  user: "0x1111111111111111111111111111111111111111" as const,
  debtToCover: 1_000_000n,
  minCollateralOut: 990_000n,
};

describe("liquidationReceiverV3", () => {
  it("round-trips the 7-field layout with routeType 0 and receiveAToken false", () => {
    const encoded = encodeLiquidationReceiverV3Params(sample);
    const decoded = decodeLiquidationReceiverV3Params(encoded);
    expect(decoded.routeType).toBe(0);
    expect(decoded.receiveAToken).toBe(false);
    expect(decoded.collateral.toLowerCase()).toBe(sample.collateral.toLowerCase());
    expect(decoded.debt.toLowerCase()).toBe(sample.debt.toLowerCase());
    expect(decoded.user.toLowerCase()).toBe(sample.user.toLowerCase());
    expect(decoded.debtToCover).toBe(sample.debtToCover);
    expect(decoded.minCollateralOut).toBe(sample.minCollateralOut);
  });

  it("rejects non-Aave routeType and receiveAToken=true at encode time", () => {
    expect(() => encodeLiquidationReceiverV3Params({ ...sample, routeType: 1 })).toThrow(/routeType 0/);
    expect(() => encodeLiquidationReceiverV3Params({ ...sample, receiveAToken: true })).toThrow(/receiveAToken/);
  });

  it("exposes stable identity constants", () => {
    expect(RECEIVER_V3_VERSION).toBe(3n);
    expect(RECEIVER_V3_LAYOUT_ID).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(() =>
      assertReceiverV3Identity({ version: 3n, layoutId: RECEIVER_V3_LAYOUT_ID }),
    ).not.toThrow();
    expect(() =>
      assertReceiverV3Identity({ version: 2n, layoutId: RECEIVER_V3_LAYOUT_ID }),
    ).toThrow(/receiverVersion/);
  });
});
