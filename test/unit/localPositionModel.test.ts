import { beforeEach, describe, expect, it } from "vitest";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
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

  it("evicts at hard cap", () => {
    for (let i = 0; i < 10; i += 1) {
      const addr = `0x${(i + 2).toString(16).padStart(40, "0")}` as typeof user;
      model.applyAaveEvent(makeBorrow(addr, usdc, 1n, BigInt(i + 10)));
    }
    expect(model.size()).toBeLessThanOrEqual(purity.positionCacheHardCap);
  });
});

function makeSupply(userAddr: typeof user, asset: typeof weth, amount: bigint, block: bigint): ParsedAavePoolEvent {
  return {
    kind: "aave_pool",
    name: "Supply",
    reserve: asset,
    user: userAddr,
    onBehalfOf: userAddr,
    amount,
    meta: { blockNumber: block, txHash: "0x1", logIndex: 0, source: "pending" },
  };
}

function makeBorrow(userAddr: typeof user, asset: typeof usdc, amount: bigint, block: bigint): ParsedAavePoolEvent {
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
