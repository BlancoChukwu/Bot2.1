import { describe, expect, it } from "vitest";
import {
  isPegDivergenceAcceptable,
  isUsdbcAsset,
  pegDivergenceBps,
  pegUsdbcFromUsdcPrice,
  resolvePegPriceWad18,
} from "../../src/oracle/pegPriceNormalizer";
import { BASE_USDC, BASE_USDBC } from "../../src/oracle/baseReserveAssets";

describe("pegPriceNormalizer", () => {
  it("pegs USDbC to USDC normalized price", () => {
    const usdc = 1_000_000_000_000_000_000n;
    expect(pegUsdbcFromUsdcPrice(usdc)).toBe(usdc);
  });

  it("detects USDbC asset", () => {
    expect(isUsdbcAsset(BASE_USDBC)).toBe(true);
  });

  it("accepts peg within 50 bps of aave price", () => {
    const peg = 1_000_000_000_000_000_000n;
    const aave = 100_000_000n;
    expect(pegDivergenceBps(peg, aave)).toBe(0);
    expect(isPegDivergenceAcceptable(peg, aave)).toBe(true);
  });

  it("resolves USDbC price from USDC map entry", () => {
    const usdc = 999_500_000_000_000_000n;
    const prices = new Map<string, bigint>([[BASE_USDC.toLowerCase(), usdc]]);
    expect(resolvePegPriceWad18(BASE_USDBC, prices)).toBe(usdc);
  });
});
