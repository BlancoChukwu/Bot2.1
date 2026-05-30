import { describe, expect, it } from "vitest";
import { evaluateOracleSanity } from "../../src/oracles/oracleSanityGate";

describe("oracle sanity gate", () => {
  it("passes when deviation is below threshold", () => {
    const result = evaluateOracleSanity({
      chain: "base",
      account: "0x00000000000000000000000000000000000000A1",
      debtAsset: "0x00000000000000000000000000000000000000B1",
      collateralAsset: "0x00000000000000000000000000000000000000C1",
      chainlinkPriceRaw: 100_000_000n,
      twapPriceRaw: 98_500_000n,
      thresholdPct: 2,
    });
    expect(result.pass).toBe(true);
  });

  it("blocks when deviation is above threshold", () => {
    const result = evaluateOracleSanity({
      chain: "base",
      account: "0x00000000000000000000000000000000000000A1",
      debtAsset: "0x00000000000000000000000000000000000000B1",
      collateralAsset: "0x00000000000000000000000000000000000000C1",
      chainlinkPriceRaw: 100_000_000n,
      twapPriceRaw: 96_000_000n,
      thresholdPct: 2,
    });
    expect(result.pass).toBe(false);
  });
});

