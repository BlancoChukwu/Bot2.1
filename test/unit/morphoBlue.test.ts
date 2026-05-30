import { describe, expect, it } from "vitest";
import { encodePreLiquidate, isPreLiquidatable } from "../../src/protocols/morphoBlue";

describe("morphoBlue helpers", () => {
  it("flags pre-liquidatable positions when health factor is below preLLTV", () => {
    expect(isPreLiquidatable({
      borrower: "0x00000000000000000000000000000000000000A1",
      healthFactorWad: 900_000_000_000_000_000n,
      lltvWad: 950_000_000_000_000_000n,
      preLltvWad: 920_000_000_000_000_000n,
    })).toBe(true);
  });

  it("encodes preLiquidate calldata", () => {
    const data = encodePreLiquidate({
      marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      borrower: "0x00000000000000000000000000000000000000A1",
      seizedAssets: 10n,
    });
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });
});

