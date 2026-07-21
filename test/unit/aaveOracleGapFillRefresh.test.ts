import { describe, expect, it, vi } from "vitest";
import { refreshGapFillPrices } from "../../src/oracle/aaveOraclePrice";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import {
  BASE_AAVE,
  BASE_GHO,
  BASE_USDC,
  BASE_USDBC,
} from "../../src/oracle/baseReserveAssets";
import type { Address, PublicClient } from "viem";

function createModel(): LocalPositionModel {
  const purity = parseEventPurityConfig({});
  return new LocalPositionModel({
    purity,
    urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
    watchHfWad: hfThresholdToWad(purity.localHfWatch),
  });
}

describe("refreshGapFillPrices", () => {
  it("re-fetches and overwrites assets that already have a real price", async () => {
    const model = createModel();
    model.markPricesBootstrapped();
    model.registerReserve(BASE_AAVE);
    const existingPrice = 2_000_000_000_000_000_000n;
    model.registerBootstrapPrice(BASE_AAVE, existingPrice, {
      answer: 200_000_000n,
      decimals: 8,
      updatedAt: 1,
      feedAddress: BASE_AAVE,
      asset: BASE_AAVE,
      source: "aave",
    });

    const client = {
      multicall: vi.fn(async () => ([{
        status: "success",
        result: 300_000_000n,
      }])),
    } as unknown as PublicClient;

    const info = vi.fn();
    const warn = vi.fn();
    const result = await refreshGapFillPrices({
      client,
      model,
      logger: { info, warn, error: vi.fn() },
    });

    expect(client.multicall).toHaveBeenCalled();
    expect(result.refreshed).toBe(1);
    expect(result.failed).toEqual([]);
    expect(model.prices.get(BASE_AAVE.toLowerCase())).toBe(3_000_000_000_000_000_000n);
    expect(info).toHaveBeenCalledWith(
      "oracle_gap_fill_refresh_start",
      expect.objectContaining({ targetCount: 1 }),
    );
    expect(info).toHaveBeenCalledWith(
      "oracle_gap_fill_refresh_complete",
      expect.objectContaining({ refreshed: 1, failedCount: 0, targetCount: 1 }),
    );
  });

  it("excludes gap-fill assets not registered in reserveConfig", async () => {
    const model = createModel();
    model.markPricesBootstrapped();
    model.registerReserve(BASE_AAVE);

    const client = {
      multicall: vi.fn(async () => ([{
        status: "success",
        result: 250_000_000n,
      }])),
    } as unknown as PublicClient;

    await refreshGapFillPrices({
      client,
      model,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const multicallArgs = (client.multicall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const requestedAssets = multicallArgs.contracts.map(
      (contract: { args: readonly Address[] }) => contract.args[0],
    );
    expect(requestedAssets).toEqual([BASE_AAVE]);
    expect(requestedAssets).not.toContain(BASE_GHO);
  });

  it("re-derives USDbC from the current USDC price", async () => {
    const model = createModel();
    model.markPricesBootstrapped();
    model.registerReserve(BASE_USDBC);
    const staleUsdbc = 900_000_000_000_000_000n;
    model.registerBootstrapPrice(BASE_USDBC, staleUsdbc, {
      answer: 90_000_000n,
      decimals: 8,
      updatedAt: 1,
      feedAddress: BASE_USDC,
      asset: BASE_USDBC,
      source: "peg",
    });
    const liveUsdc = 1_010_000_000_000_000_000n;
    model.registerBootstrapPrice(BASE_USDC, liveUsdc, {
      answer: 101_000_000n,
      decimals: 8,
      updatedAt: 100,
      feedAddress: BASE_USDC,
      asset: BASE_USDC,
      source: "chainlink",
    });

    const client = {
      multicall: vi.fn(),
    } as unknown as PublicClient;

    const result = await refreshGapFillPrices({
      client,
      model,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowSec: 100,
    });

    expect(client.multicall).not.toHaveBeenCalled();
    expect(result.refreshed).toBe(1);
    expect(model.prices.get(BASE_USDBC.toLowerCase())).toBe(liveUsdc);
    expect(model.prices.get(BASE_USDBC.toLowerCase())).not.toBe(staleUsdbc);
  });

  it("retains last-known-good price when multicall entry fails", async () => {
    const model = createModel();
    model.markPricesBootstrapped();
    model.registerReserve(BASE_AAVE);
    model.registerReserve(BASE_GHO);
    const aaveKey = BASE_AAVE.toLowerCase();
    const ghoKey = BASE_GHO.toLowerCase();
    const aavePrice = 2_500_000_000_000_000_000n;
    const ghoPrice = 1_000_000_000_000_000_000n;
    model.registerBootstrapPrice(BASE_AAVE, aavePrice, {
      answer: 250_000_000n,
      decimals: 8,
      updatedAt: 1,
      feedAddress: BASE_AAVE,
      asset: BASE_AAVE,
      source: "aave",
    });
    model.registerBootstrapPrice(BASE_GHO, ghoPrice, {
      answer: 100_000_000n,
      decimals: 8,
      updatedAt: 1,
      feedAddress: BASE_GHO,
      asset: BASE_GHO,
      source: "aave",
    });

    const client = {
      multicall: vi.fn(async () => ([
        { status: "success", result: 260_000_000n },
        { status: "failure", error: new Error("revert") },
      ])),
    } as unknown as PublicClient;

    const warn = vi.fn();
    const result = await refreshGapFillPrices({
      client,
      model,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });

    expect(result.refreshed).toBe(1);
    expect(result.failed).toEqual([BASE_AAVE]);
    expect(model.prices.get(ghoKey)).toBe(2_600_000_000_000_000_000n);
    expect(model.prices.get(aaveKey)).toBe(aavePrice);
    expect(warn).toHaveBeenCalledWith("oracle_gap_fill_refresh_asset_failed", { asset: BASE_AAVE });
  });

  it("catches multicall throws and returns without throwing", async () => {
    const model = createModel();
    model.markPricesBootstrapped();
    model.registerReserve(BASE_AAVE);

    const client = {
      multicall: vi.fn(async () => {
        throw new Error("rpc_down");
      }),
    } as unknown as PublicClient;

    const warn = vi.fn();
    const result = await refreshGapFillPrices({
      client,
      model,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });

    expect(result).toEqual({
      refreshed: 0,
      failed: [BASE_AAVE],
      targetCount: 1,
      refreshedAssets: [],
    });
    expect(warn).toHaveBeenCalledWith(
      "oracle_gap_fill_refresh_failed",
      expect.objectContaining({ error: "Error: rpc_down" }),
    );
  });
});
