import { describe, expect, it } from "vitest";
import {
  compoundHopPricesToUsd8,
  tickToPriceX18,
  twapUsdPathForAsset,
} from "../../src/oracle/uniswapV3TwapPrice";
import {
  evaluateLiquidationOracleSanity,
  evaluateOracleSanity,
} from "../../src/oracles/oracleSanityGate";

const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WSTETH = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as const;

describe("oracle sanity (real secondary)", () => {
  it("fails when either primary or secondary is zero", () => {
    expect(evaluateOracleSanity({
      chain: "base",
      account: "0x00000000000000000000000000000000000000A1",
      debtAsset: USDC,
      collateralAsset: WETH,
      chainlinkPriceRaw: 0n,
      twapPriceRaw: 100_000_000n,
    }).pass).toBe(false);
  });

  it("evaluates 2% against compounded multi-hop USD, not per-hop", async () => {
    // Compounded TWAP $2900 vs Chainlink $3000 → 3.33% on the compounded price (not per-hop).
    const compounded = compoundHopPricesToUsd8([10n ** 18n, 2_900n * 10n ** 18n]);
    expect(compounded).toBe(290_000_000_000n);

    const result = await evaluateLiquidationOracleSanity({
      chain: "base",
      account: "0x00000000000000000000000000000000000000A1",
      debtAsset: USDC,
      collateralAsset: WSTETH,
      primaryUsd8: async (asset) => {
        if (asset.toLowerCase() === USDC.toLowerCase()) {
          return 100_000_000n;
        }
        return 300_000_000_000n;
      },
      resolveTwap: async (asset) => {
        if (asset.toLowerCase() === USDC.toLowerCase()) {
          return { ok: true, priceUsd8: 100_000_000n, hopsUsed: 0 };
        }
        return { ok: true, priceUsd8: compounded, hopsUsed: 2 };
      },
    });
    expect(result.pass).toBe(false);
    expect(result.collateral.pass).toBe(false);
    expect(result.collateral.deviationPct).toBeGreaterThan(2);
    expect(result.debt.pass).toBe(true);
  });

  it("fails closed when either multi-hop hop is unavailable (first hop)", async () => {
    const result = await evaluateLiquidationOracleSanity({
      chain: "base",
      account: "0x00000000000000000000000000000000000000A1",
      debtAsset: USDC,
      collateralAsset: WSTETH,
      primaryUsd8: async () => 300_000_000_000n,
      resolveTwap: async (asset) => {
        if (asset.toLowerCase() === USDC.toLowerCase()) {
          return { ok: true, priceUsd8: 100_000_000n, hopsUsed: 0 };
        }
        return { ok: false, reason: "pool_thin", failedHopIndex: 0 };
      },
    });
    expect(result.pass).toBe(false);
    expect(result.collateral.twapFailureReason).toBe("pool_thin");
    expect(result.collateral.failedHopIndex).toBe(0);
  });

  it("fails closed when the second hop of a multi-hop path is thin", async () => {
    const result = await evaluateLiquidationOracleSanity({
      chain: "base",
      account: "0x00000000000000000000000000000000000000A1",
      debtAsset: USDC,
      collateralAsset: WSTETH,
      primaryUsd8: async () => 300_000_000_000n,
      resolveTwap: async (asset) => {
        if (asset.toLowerCase() === USDC.toLowerCase()) {
          return { ok: true, priceUsd8: 100_000_000n, hopsUsed: 0 };
        }
        return { ok: false, reason: "pool_thin", failedHopIndex: 1 };
      },
    });
    expect(result.pass).toBe(false);
    expect(result.collateral.failedHopIndex).toBe(1);
  });

  it("requires both debt and collateral to pass", async () => {
    const result = await evaluateLiquidationOracleSanity({
      chain: "base",
      account: "0x00000000000000000000000000000000000000A1",
      debtAsset: USDC,
      collateralAsset: WETH,
      primaryUsd8: async (asset) => (
        asset.toLowerCase() === USDC.toLowerCase() ? 100_000_000n : 300_000_000_000n
      ),
      resolveTwap: async (asset) => {
        if (asset.toLowerCase() === USDC.toLowerCase()) {
          return { ok: false, reason: "observe_failed" };
        }
        return { ok: true, priceUsd8: 300_000_000_000n, hopsUsed: 1 };
      },
    });
    expect(result.pass).toBe(false);
    expect(result.debt.pass).toBe(false);
    expect(result.collateral.pass).toBe(true);
  });

  it("maps wstETH to a two-hop WETH→USDC path", () => {
    const path = twapUsdPathForAsset(WSTETH);
    expect(path).toEqual({
      kind: "hops",
      hops: [
        { tokenIn: WSTETH, tokenOut: WETH, fee: 100 },
        { tokenIn: WETH, tokenOut: USDC, fee: 3_000 },
      ],
    });
  });

  it("tickToPriceX18 is positive for a typical ETH tick", () => {
    expect(tickToPriceX18(0)).toBe(10n ** 18n);
    expect(tickToPriceX18(100)).toBeGreaterThan(10n ** 18n);
  });
});
