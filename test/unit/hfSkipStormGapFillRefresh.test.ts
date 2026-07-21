import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import { refreshGapFillPrices } from "../../src/oracle/aaveOraclePrice";
import { BASE_AAVE, BASE_USDC, BASE_WETH } from "../../src/oracle/baseReserveAssets";

const user = "0x1111111111111111111111111111111111111111" as Address;
const NOW_SEC = 1_700_000_000;

function createModel(logger?: {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
}): LocalPositionModel {
  const purity = parseEventPurityConfig({});
  return new LocalPositionModel({
    purity,
    urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
    watchHfWad: hfThresholdToWad(purity.localHfWatch),
    ...(logger === undefined ? {} : { logger }),
  });
}

describe("HF skip storm — gap-fill refresh write + tier recompute", () => {
  it("registerAavePrice writes both prices and feedStates with source=aave", async () => {
    const model = createModel();
    model.markPricesBootstrapped();
    model.registerReserve(BASE_AAVE);

    const client = {
      multicall: vi.fn(async () => ([{ status: "success", result: 250_000_000n }])),
    } as unknown as PublicClient;

    const result = await refreshGapFillPrices({
      client,
      model,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowSec: NOW_SEC,
    });

    expect(result.refreshed).toBe(1);
    expect(result.refreshedAssets.map((a) => a.toLowerCase())).toEqual([BASE_AAVE.toLowerCase()]);
    expect(model.prices.get(BASE_AAVE.toLowerCase())).toBe(2_500_000_000_000_000_000n);
    const feed = model.feedStates.get(BASE_AAVE.toLowerCase());
    expect(feed?.source).toBe("aave");
    expect(feed?.updatedAt).toBe(NOW_SEC);
    expect(feed?.answer).toBe(250_000_000n);
  });

  it("recomputeHf does not treat aave-sourced gap-fill prices as Chainlink-stale", async () => {
    const model = createModel();
    model.registerReserve(BASE_AAVE, 8500n);
    model.registerReserve(BASE_USDC, 8500n);
    model.markPricesBootstrapped();

    // Stale updatedAt would fail Chainlink heartbeat — aave source must skip that check.
    model.registerBootstrapPrice(BASE_AAVE, 2_500_000_000_000_000_000n, {
      answer: 250_000_000n,
      decimals: 8,
      updatedAt: NOW_SEC - 100_000,
      feedAddress: BASE_AAVE,
      asset: BASE_AAVE,
      source: "aave",
    });
    model.registerBootstrapPrice(BASE_USDC, 1_000_000_000_000_000_000n, {
      answer: 100_000_000n,
      decimals: 8,
      updatedAt: NOW_SEC,
      feedAddress: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
      asset: BASE_USDC,
      source: "chainlink",
    });

    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_200_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [
        { asset: BASE_AAVE, scaledCollateral: 1_000n, scaledDebt: 0n },
        { asset: BASE_USDC, scaledCollateral: 0n, scaledDebt: 100n },
      ],
    });

    const position = model.positions.get(user.toLowerCase());
    expect(position).toBeDefined();
    const result = model.recomputeHf(position!, NOW_SEC);
    expect(result.status).toBe("ok");
  });

  it("recomputeTiersForAssets updates cached HF after gap-fill price overwrite", async () => {
    const model = createModel();
    model.registerReserve(BASE_AAVE, 8500n);
    model.registerReserve(BASE_USDC, 8500n);
    model.markPricesBootstrapped();

    model.registerBootstrapPrice(BASE_AAVE, 2_000_000_000_000_000_000n, {
      answer: 200_000_000n,
      decimals: 8,
      updatedAt: NOW_SEC - 60,
      feedAddress: BASE_AAVE,
      asset: BASE_AAVE,
      source: "aave",
    });
    model.registerBootstrapPrice(BASE_USDC, 1_000_000_000_000_000_000n, {
      answer: 100_000_000n,
      decimals: 8,
      updatedAt: NOW_SEC,
      feedAddress: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
      asset: BASE_USDC,
      source: "chainlink",
    });

    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_500_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [
        { asset: BASE_AAVE, scaledCollateral: 1_000_000_000_000_000_000n, scaledDebt: 0n },
        { asset: BASE_USDC, scaledCollateral: 0n, scaledDebt: 500_000_000n },
      ],
    });

    const position = model.positions.get(user.toLowerCase())!;
    const before = model.recomputeHf(position, NOW_SEC);
    expect(before.status).toBe("ok");
    if (before.status !== "ok") {
      throw new Error("expected ok");
    }
    position.cachedHfWad = before.hf;

    // Crash AAVE price → HF must drop when tiers are recomputed for the refreshed asset.
    model.registerBootstrapPrice(BASE_AAVE, 1_000_000_000_000_000_000n, {
      answer: 100_000_000n,
      decimals: 8,
      updatedAt: NOW_SEC,
      feedAddress: BASE_AAVE,
      asset: BASE_AAVE,
      source: "aave",
    });

    const changes = model.recomputeTiersForAssets([BASE_AAVE], NOW_SEC);
    expect(changes.length).toBeGreaterThan(0);
    expect(position.cachedHfWad < before.hf).toBe(true);
  });

  it("applyFeedPriceUpdate tags source=chainlink so freshness and gap-fill do not collide on source", () => {
    const model = createModel();
    model.markPricesBootstrapped();
    model.registerReserve(BASE_WETH, 8500n);
    model.applyFeedPriceUpdate(
      BASE_WETH,
      "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70",
      300_000_000_000n,
      8,
      NOW_SEC,
    );
    expect(model.feedStates.get(BASE_WETH.toLowerCase())?.source).toBe("chainlink");
  });
});
