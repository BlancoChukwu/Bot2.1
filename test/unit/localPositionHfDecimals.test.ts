import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";

const weth = "0x4200000000000000000000000000000000000006" as Address;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const wsteth = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Address;
const cbbtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;
const wethFeed = "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70" as Address;
const user = "0x1111111111111111111111111111111111111111" as Address;

const WAD = 10n ** 18n;
const NOW_SEC = 1_700_000_000;

/** $2000 WETH, $1 USDC, $1.2 wstETH, $60000 cbBTC — wad18. */
const WETH_PX = 2_000n * WAD;
const USDC_PX = 1n * WAD;
const WSTETH_PX = 2_400n * WAD;
const CBBTC_PX = 60_000n * WAD;

describe("local HF decimals normalization", () => {
  const purity = parseEventPurityConfig({ POSITION_CACHE_HARD_CAP: "50" });
  let model: LocalPositionModel;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
      logger,
    });
    model.markPricesBootstrapped();
  });

  function price(asset: Address, px: bigint, feed: Address = wethFeed): void {
    model.registerBootstrapPrice(asset, px, {
      answer: px / 10n ** 10n,
      decimals: 8,
      updatedAt: NOW_SEC,
      feedAddress: feed,
      asset,
      source: "aave",
    });
  }

  it("1) USDC coll + WETH debt matches chain-shaped HF (mixed decimals)", () => {
    // 1000 USDC (6 dec raw = 1000e6) coll @ $1, LT 7800; 0.5 WETH debt @ $2000
    model.registerReserve(usdc, 7800n, 6);
    model.registerReserve(weth, 8300n, 18);
    price(usdc, USDC_PX);
    price(weth, WETH_PX);

    const usdcRaw = 1_000n * 10n ** 6n;
    const wethDebtRaw = 5n * 10n ** 17n; // 0.5 WETH
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 1n,
      eModeCategoryId: 0,
      healthFactorWad: WAD,
      totalCollateralBase: 0n,
      totalDebtBase: 1n,
      liquidationThreshold: 7800n,
      reserves: [
        { asset: usdc, scaledCollateral: usdcRaw, scaledDebt: 0n },
        { asset: weth, scaledCollateral: 0n, scaledDebt: wethDebtRaw },
      ],
    });

    const position = model.positions.get(user.toLowerCase())!;
    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    // HF = (1000 * 1 * 0.78) / (0.5 * 2000) = 780 / 1000 = 0.78
    const expected = (780n * WAD) / 1000n;
    const driftBps = result.hf > expected
      ? ((result.hf - expected) * 10_000n) / expected
      : ((expected - result.hf) * 10_000n) / expected;
    expect(driftBps).toBeLessThan(5n);
  });

  it("2) dust-magnitude precision: raw 5 at 8 decimals stays non-zero (multiply-first)", () => {
    model.registerReserve(cbbtc, 7800n, 8);
    model.registerReserve(weth, 8300n, 18);
    price(cbbtc, CBBTC_PX);
    price(weth, WETH_PX);

    // Wrong order would do 5n / 10n**8n = 0n and zero the leg.
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 1n,
      eModeCategoryId: 0,
      healthFactorWad: WAD,
      totalCollateralBase: 1n,
      totalDebtBase: 1n,
      liquidationThreshold: 7800n,
      reserves: [
        { asset: cbbtc, scaledCollateral: 5n, scaledDebt: 0n },
        { asset: weth, scaledCollateral: 0n, scaledDebt: 1n * 10n ** 15n }, // 0.001 WETH
      ],
    });

    const position = model.positions.get(user.toLowerCase())!;
    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    // cbBTC: 5/1e8 * 60000 * 0.78 = 0.0234 USD weighted
    // debt: 0.001 * 2000 = 2 USD
    // HF ≈ 0.0234 / 2 = 0.0117 > 0
    expect(result.hf).toBeGreaterThan(0n);
    // Wrong order (5n / 10n**8n) would yield HF=0; multiply-first keeps ~0.00117.
    expect(result.hf).toBeGreaterThan(WAD / 1000n); // > 0.001
  });

  it("3) same-decimal WETH/wstETH book: HF matches pre-fix (no /decimals) formula", () => {
    model.registerReserve(weth, 8300n, 18);
    model.registerReserve(wsteth, 7900n, 18);
    price(weth, WETH_PX);
    price(wsteth, WSTETH_PX);

    const coll = 2n * 10n ** 18n;
    const debt = 1n * 10n ** 18n;
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 1n,
      eModeCategoryId: 0,
      healthFactorWad: WAD,
      totalCollateralBase: 1n,
      totalDebtBase: 1n,
      liquidationThreshold: 8300n,
      reserves: [
        { asset: weth, scaledCollateral: coll, scaledDebt: 0n },
        { asset: wsteth, scaledCollateral: 0n, scaledDebt: debt },
      ],
    });

    const position = model.positions.get(user.toLowerCase())!;
    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    // Pre-fix (no decimals div): HF = ((coll*pxW*LT)/BPS * WAD) / (debt*pxD)
    const preFix = (coll * WETH_PX * 8300n * WAD) / (10_000n * debt * WSTETH_PX);
    // Post-fix divides both sides by 1e18 → identical HF
    expect(result.hf).toBe(preFix);
  });

  it("4) low-decimal debt side (USDC debt + WETH coll) is symmetric", () => {
    model.registerReserve(weth, 8300n, 18);
    model.registerReserve(usdc, 7800n, 6);
    price(weth, WETH_PX);
    price(usdc, USDC_PX);

    // 1 WETH coll @ $2000 LT 8300; 1000 USDC debt @ $1
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 1n,
      eModeCategoryId: 0,
      healthFactorWad: WAD,
      totalCollateralBase: 1n,
      totalDebtBase: 1n,
      liquidationThreshold: 8300n,
      reserves: [
        { asset: weth, scaledCollateral: 1n * 10n ** 18n, scaledDebt: 0n },
        { asset: usdc, scaledCollateral: 0n, scaledDebt: 1_000n * 10n ** 6n },
      ],
    });

    const position = model.positions.get(user.toLowerCase())!;
    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }

    // HF = (2000 * 0.83) / 1000 = 1.66
    const expected = (1_660n * WAD) / 1_000n;
    const driftBps = result.hf > expected
      ? ((result.hf - expected) * 10_000n) / expected
      : ((expected - result.hf) * 10_000n) / expected;
    expect(driftBps).toBeLessThan(5n);
  });

  it("5) missing decimals fails loud (error status + RESERVE_DECIMALS_MISSING log)", () => {
    model.registerReserve(weth, 8300n); // no decimals
    model.registerReserve(usdc, 7800n, 6);
    price(weth, WETH_PX);
    price(usdc, USDC_PX);

    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 1n,
      eModeCategoryId: 0,
      healthFactorWad: WAD,
      totalCollateralBase: 1n,
      totalDebtBase: 1n,
      liquidationThreshold: 8300n,
      reserves: [
        { asset: weth, scaledCollateral: 1n * 10n ** 18n, scaledDebt: 0n },
        { asset: usdc, scaledCollateral: 0n, scaledDebt: 1_000n * 10n ** 6n },
      ],
    });

    const position = model.positions.get(user.toLowerCase())!;
    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toContain("missing_reserve_decimals");
      expect(result.reason.toLowerCase()).toContain(weth.toLowerCase());
    }
    expect(logger.error).toHaveBeenCalledWith(
      "RESERVE_DECIMALS_MISSING",
      expect.objectContaining({ account: user }),
    );
  });

  it("setReserveDecimals rejects inventing via conflict and invalid values", () => {
    model.registerReserve(weth, 8300n, 18);
    expect(() => model.setReserveDecimals(weth, 6)).toThrow(/reserve_decimals_conflict/);
    expect(() => model.setReserveDecimals(usdc, -1)).toThrow(/invalid_reserve_decimals/);
    expect(() => model.setReserveDecimals(usdc, 18.5)).toThrow(/invalid_reserve_decimals/);
  });
});
