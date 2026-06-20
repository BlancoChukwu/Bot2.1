import { describe, expect, it } from "vitest";
import { reservesTouchAllowlist } from "../../src/config/watchlistReserveFilter";

const weth = "0x4200000000000000000000000000000000000006" as const;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const other = "0x2222222222222222222222222222222222222222" as const;

describe("watchlistReserveFilter", () => {
  it("matches when debt touches allowlist asset", () => {
    expect(reservesTouchAllowlist(
      [{ asset: usdc, scaledCollateral: 0n, scaledDebt: 100n }],
      [weth, usdc],
    )).toBe(true);
  });

  it("rejects when only non-allowlist assets are present", () => {
    expect(reservesTouchAllowlist(
      [{ asset: other, scaledCollateral: 0n, scaledDebt: 100n }],
      [weth, usdc],
    )).toBe(false);
  });
});
