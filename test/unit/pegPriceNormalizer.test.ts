import { describe, expect, it } from "vitest";
import {
  isPegDivergenceAcceptable,
  isUsdbcAsset,
  pegDivergenceBps,
  pegUsdbcFromUsdcPrice,
} from "../../src/oracle/pegPriceNormalizer";
import { BASE_USDBC } from "../../src/oracle/baseReserveAssets";

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
});
