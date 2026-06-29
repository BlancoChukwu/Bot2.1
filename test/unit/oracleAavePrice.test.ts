import { describe, expect, it } from "vitest";
import { normalizeAavePriceToWad18 } from "../../src/oracle/aaveOraclePrice";
import { BASE_USDC } from "../../src/oracle/baseReserveAssets";

describe("aaveOraclePrice", () => {
  it("normalizes 8-decimal oracle price to wad18", () => {
    expect(normalizeAavePriceToWad18(100_000_000n)).toBe(1_000_000_000_000_000_000n);
    expect(normalizeAavePriceToWad18(0n)).toBe(0n);
  });

  it("exports canonical USDC address", () => {
    expect(BASE_USDC).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
});
