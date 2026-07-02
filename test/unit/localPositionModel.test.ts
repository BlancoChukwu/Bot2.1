import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { MAX_UINT256 } from "../../src/config/oracleBootstrap";
import {
  LocalPositionModel,
  type UserPosition,
} from "../../src/monitors/localPositionModel";
import type { ParsedAavePoolEvent } from "../../src/monitors/aaveEventParser";

const weth = "0x4200000000000000000000000000000000000006" as const;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const usdbc = "0xd9aaEC86B65d86f6A7B5B1b0c42FFA531710B6CA" as const;
const wethFeed = "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70" as const;
const user = "0x1111111111111111111111111111111111111111" as const;

const WETH_NORMALIZED = 3_000_000_000_000_000_000n;
const USDC_NORMALIZED = 1_000_000_000_000_000_000n;
const NOW_SEC = 1_700_000_000;

describe("localPositionModel HfResult", () => {
  const purity = parseEventPurityConfig({ POSITION_CACHE_HARD_CAP: "5" });
  let model: LocalPositionModel;

  beforeEach(() => {
    model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      reserveAllowlist: [weth, usdc],
    });
    model.registerReserve(weth, 8500n);
    model.registerReserve(usdc, 8500n);
  });

  function seedTwoAssetPosition(): UserPosition {
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_200_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [
        { asset: weth, scaledCollateral: 1_000n, scaledDebt: 0n },
        { asset: usdc, scaledCollateral: 0n, scaledDebt: 100n },
      ],
    });
    const position = model.positions.get(user.toLowerCase());
    if (position === undefined) {
      throw new Error("position missing");
    }
    return position;
  }

  function registerWarmPrices(): void {
    const now = NOW_SEC;
    model.registerBootstrapPrice(weth, WETH_NORMALIZED, {
      answer: 300_000_000_000n,
      decimals: 8,
      updatedAt: now,
      feedAddress: wethFeed,
      asset: weth,
    });
    model.registerBootstrapPrice(usdc, USDC_NORMALIZED, {
      answer: 100_000_000n,
      decimals: 8,
      updatedAt: now,
      feedAddress: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
      asset: usdc,
    });
    model.markPricesBootstrapped();
  }

  it("returns price_incomplete when prices are not bootstrapped", () => {
    model.registerPriceFeed("0xfeed", weth, WETH_NORMALIZED);
    model.registerPriceFeed("0xfeed2", usdc, USDC_NORMALIZED);
    const position = seedTwoAssetPosition();

    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("price_incomplete");
    if (result.status === "price_incomplete") {
      expect(result.missingAssets.length).toBeGreaterThan(0);
    }
  });

  it("returns price_incomplete when a position asset still has placeholder 1n price", () => {
    model.markPricesBootstrapped();
    model.registerBootstrapPrice(weth, WETH_NORMALIZED, {
      answer: 300_000_000_000n,
      decimals: 8,
      updatedAt: NOW_SEC,
      feedAddress: wethFeed,
      asset: weth,
    });
    model.registerPriceFeed("0xfeed2", usdc, 1n);
    const position = seedTwoAssetPosition();

    const result = model.recomputeHf(position, NOW_SEC);
    expect(result).toEqual({
      status: "price_incomplete",
      missingAssets: [usdc.toLowerCase() as Address],
    });
  });

  it("returns no_debt sentinel when total debt is zero", () => {
    registerWarmPrices();
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: MAX_UINT256,
      totalCollateralBase: 1_000n,
      totalDebtBase: 0n,
      liquidationThreshold: 8_500n,
      reserves: [{ asset: weth, scaledCollateral: 1_000n, scaledDebt: 0n }],
    });
    const position = model.positions.get(user.toLowerCase())!;

    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("no_debt");
    if (result.status === "no_debt") {
      expect(result.hf).toBe(MAX_UINT256);
    }
  });

  it("returns ok with plausible HF when prices are warm and bootstrapped", () => {
    registerWarmPrices();
    const position = seedTwoAssetPosition();

    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.hf).toBeGreaterThan(500_000_000_000_000_000n);
      expect(result.hf).toBeLessThan(30_000_000_000_000_000_000n);
    }
  });

  it("propagates USDbC peg price when USDC feed updates", () => {
    registerWarmPrices();
    model.registerReserve(usdbc, 8500n);
    model.registerPriceFeed(usdc, usdbc, 1n);

    model.applyFeedPriceUpdate(
      usdc,
      "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
      100_050_000n,
      8,
      NOW_SEC,
    );

    expect(model.prices.get(usdbc.toLowerCase())).toBeGreaterThan(1n);
    expect(model.feedStates.get(usdbc.toLowerCase())?.source).toBe("peg");
  });

  it("computes HF for USDbC positions when USDC is fresh without USDbC map entry", () => {
    registerWarmPrices();
    model.registerReserve(usdbc, 8500n);
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_200_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [
        { asset: usdbc, scaledCollateral: 1_000n, scaledDebt: 0n },
        { asset: weth, scaledCollateral: 0n, scaledDebt: 100n },
      ],
    });
    const position = model.positions.get(user.toLowerCase())!;

    const result = model.recomputeHf(position, NOW_SEC);

    expect(result.status).toBe("ok");
    expect(model.prices.get(usdbc.toLowerCase())).toBe(USDC_NORMALIZED);
  });

  it("applyFeedPriceUpdate uses chainlink updatedAt for staleness checks", () => {
    registerWarmPrices();
    const position = seedTwoAssetPosition();

    const freshUpdatedAt = NOW_SEC - 100;
    model.applyFeedPriceUpdate(
      weth,
      wethFeed,
      300_000_000_000n,
      8,
      freshUpdatedAt,
    );

    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("ok");
    expect(model.feedStates.get(weth.toLowerCase())?.updatedAt).toBe(freshUpdatedAt);
  });

  it("returns price_stale when feed updatedAt exceeds heartbeat threshold", () => {
    registerWarmPrices();
    const position = seedTwoAssetPosition();
    const staleUpdatedAt = NOW_SEC - 100_000;

    model.registerBootstrapPrice(weth, WETH_NORMALIZED, {
      answer: 300_000_000_000n,
      decimals: 8,
      updatedAt: staleUpdatedAt,
      feedAddress: wethFeed,
      asset: weth,
    });

    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("price_stale");
    if (result.status === "price_stale") {
      expect(result.staleAssets).toContain(weth);
    }
  });

  it("returns error without throwing when HF math fails", () => {
    registerWarmPrices();
    const position = seedTwoAssetPosition();
    const failingCollateral = new Map<string, bigint>();
    failingCollateral.set(weth.toLowerCase(), 1_000n);
    Object.defineProperty(failingCollateral, Symbol.iterator, {
      value: function* throwOnIterate(): Generator<[string, bigint]> {
        throw new Error("forced hf failure");
      },
    });
    position.collateral = failingCollateral;

    const result = model.recomputeHf(position, NOW_SEC);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toContain("forced hf failure");
    }
  });

  it("classifies tier thresholds from local hf wad", () => {
    expect(model.classifyTier(1_200_000_000_000_000_000n)).toBe("healthy");
    expect(model.classifyTier(1_080_000_000_000_000_000n)).toBe("watch");
    expect(model.classifyTier(1_040_000_000_000_000_000n)).toBe("urgent");
    expect(model.classifyTier(990_000_000_000_000_000n)).toBe("liquidatable");
  });

  it("keeps snapshot HF when feed recompute diverges in danger zone", () => {
    const snapshotHf = 985_667_837_263_193_100n;
    registerWarmPrices();
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: snapshotHf,
      totalCollateralBase: 51_444n,
      totalDebtBase: 41_859n,
      liquidationThreshold: 8_500n,
      reserves: [
        { asset: weth, scaledCollateral: 1_000_000_000_000n, scaledDebt: 0n },
        { asset: usdc, scaledCollateral: 0n, scaledDebt: 500_000_000_000n },
      ],
    });

    model.applyFeedPriceUpdate(weth, wethFeed, 300_000_000_000n, 8, NOW_SEC);
    const position = model.positions.get(user.toLowerCase())!;
    expect(position.cachedHfWad).toBeLessThan(1_100_000_000_000_000_000n);
    expect(position.cachedHfWad).toBeGreaterThan(900_000_000_000_000_000n);
    expect(model.classifyTier(position.cachedHfWad)).not.toBe("healthy");
  });

  it("evicts at hard cap for fully seeded positions", () => {
    model.markPricesBootstrapped();
    for (let i = 0; i < 10; i += 1) {
      const addr = `0x${(i + 2).toString(16).padStart(40, "0")}` as typeof user;
      model.seedFromOnChainSnapshot({
        account: addr,
        blockNumber: BigInt(i + 10),
        eModeCategoryId: 0,
        healthFactorWad: 1_200_000_000_000_000_000n,
        totalCollateralBase: 1_000n,
        totalDebtBase: 100n,
        liquidationThreshold: 8_500n,
        reserves: [{ asset: usdc, scaledCollateral: 0n, scaledDebt: 100n }],
      });
    }
    expect(model.size()).toBeLessThanOrEqual(purity.positionCacheHardCap);
  });
});

describe("localPositionModel event handling", () => {
  const purity = parseEventPurityConfig({ POSITION_CACHE_HARD_CAP: "5" });
  let model: LocalPositionModel;

  beforeEach(() => {
    model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
      reserveAllowlist: [weth, usdc],
    });
    model.registerReserve(weth, 8500n);
    model.registerReserve(usdc, 8500n);
    model.registerPriceFeed("0xfeed", weth, 3_000_000_000_000_000_000n);
    model.registerPriceFeed("0xfeed2", usdc, 1_000_000_000_000_000_000n);
    model.markPricesBootstrapped();
  });

  it("requests first-touch reconcile for new live events", () => {
    const result = model.applyAaveEvent(makeBorrow(user, usdc, 1n, 10n));
    expect(result.changes).toHaveLength(0);
    expect(result.firstTouchReconcile).toBe(user);
    expect(model.isFullySeeded(user)).toBe(false);
  });

  it("rejects zero address events", () => {
    const zero = "0x0000000000000000000000000000000000000000" as Address;
    const result = model.applyAaveEvent(makeBorrow(zero, usdc, 1n, 10n));
    expect(result.changes).toHaveLength(0);
    expect(result.firstTouchReconcile).toBeUndefined();
    expect(model.size()).toBe(0);
  });

  it("skips new positions on non-allowlist reserves", () => {
    const otherAsset = "0x2222222222222222222222222222222222222222" as Address;
    model.registerReserve(otherAsset);
    const result = model.applyAaveEvent(makeBorrow(user, otherAsset, 1n, 10n));
    expect(result.firstTouchReconcile).toBeUndefined();
    expect(model.size()).toBe(0);
  });

  it("marks bootstrap snapshots as fully seeded", () => {
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_200_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [{ asset: usdc, scaledCollateral: 0n, scaledDebt: 100n }],
    });
    expect(model.isFullySeeded(user)).toBe(true);
    const change = model.tierChangeForAccount(user, false);
    expect(change?.localHfWad).not.toBe(MAX_UINT256);
  });
});

function makeBorrow(userAddr: Address, asset: Address, amount: bigint, block: bigint): ParsedAavePoolEvent {
  return {
    kind: "aave_pool",
    name: "Borrow",
    reserve: asset,
    user: userAddr,
    onBehalfOf: userAddr,
    amount,
    meta: { blockNumber: block, txHash: "0x2", logIndex: 0, source: "pending" },
  };
}
