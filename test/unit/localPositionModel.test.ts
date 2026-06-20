import type { Address } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel, MAX_HF_WAD } from "../../src/monitors/localPositionModel";
import type { ParsedAavePoolEvent } from "../../src/monitors/aaveEventParser";

const weth = "0x4200000000000000000000000000000000000006" as const;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const user = "0x1111111111111111111111111111111111111111" as const;

describe("localPositionModel", () => {
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
    model.registerPriceFeed("0xfeed", weth, 3_000_000_000_000n);
    model.registerPriceFeed("0xfeed2", usdc, 100_000_000n);
  });

  it("classifies tier thresholds from local hf wad", () => {
    expect(model.classifyTier(1_200_000_000_000_000_000n)).toBe("healthy");
    expect(model.classifyTier(1_080_000_000_000_000_000n)).toBe("watch");
    expect(model.classifyTier(1_040_000_000_000_000_000n)).toBe("urgent");
    expect(model.classifyTier(990_000_000_000_000_000n)).toBe("liquidatable");
  });

  it("evicts at hard cap for fully seeded positions", () => {
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
    expect(change?.localHfWad).not.toBe(MAX_HF_WAD);
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
