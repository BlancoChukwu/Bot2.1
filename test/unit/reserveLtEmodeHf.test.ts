import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import {
  decodeLiquidationThresholdBps,
  isReserveEnabledOnBitmap,
  parseReserveConfigurationData,
} from "../../src/monitors/reserveConfiguration";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";

const weth = "0x4200000000000000000000000000000000000006" as Address;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

function makeModel(): LocalPositionModel {
  const purity = parseEventPurityConfig({});
  return new LocalPositionModel({
    purity,
    urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
    watchHfWad: hfThresholdToWad(purity.localHfWatch),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("decodeLiquidationThresholdBps", () => {
  it("reads bits 16–31 from packed configuration", () => {
    // LTV=8000 (bits 0–15), LT=7800 (bits 16–31)
    const configuration = 8000n | (7800n << 16n);
    expect(decodeLiquidationThresholdBps(configuration)).toBe(7800n);
  });

  it("reads 8500 when that is the packed LT", () => {
    const configuration = 8000n | (8500n << 16n);
    expect(decodeLiquidationThresholdBps(configuration)).toBe(8500n);
  });
});

describe("parseReserveConfigurationData", () => {
  it("parses named PDP result", () => {
    const parsed = parseReserveConfigurationData({
      decimals: 18n,
      ltv: 8000n,
      liquidationThreshold: 7800n,
      liquidationBonus: 10500n,
    });
    expect(parsed).toEqual({
      liquidationThresholdBps: 7800n,
      liquidationBonus: 10500n,
    });
  });

  it("parses positional PDP tuple", () => {
    const parsed = parseReserveConfigurationData([
      18n,
      8000n,
      8300n,
      10500n,
      1000n,
      true,
      true,
      false,
      true,
      false,
    ]);
    expect(parsed?.liquidationThresholdBps).toBe(8300n);
    expect(parsed?.liquidationBonus).toBe(10500n);
  });
});

describe("isReserveEnabledOnBitmap", () => {
  it("checks reserve id bit", () => {
    const bitmap = 1n << 3n; // reserve id 3
    expect(isReserveEnabledOnBitmap(bitmap, 3)).toBe(true);
    expect(isReserveEnabledOnBitmap(bitmap, 2)).toBe(false);
  });
});

describe("recomputeHf eMode LT override", () => {
  it("uses base reserve LT when eMode category is 0", () => {
    const model = makeModel();
    model.markPricesBootstrapped();
    model.registerReserve(weth, 7800n, 18);
    model.registerReserve(usdc, 7800n, 6);
    model.setReserveId(weth, 1);
    model.registerBootstrapPrice(weth, 10n ** 18n, {
      answer: 1n,
      decimals: 8,
      updatedAt: Math.floor(Date.now() / 1000),
      feedAddress: weth,
      asset: weth,
      source: "chainlink",
    });
    model.registerBootstrapPrice(usdc, 10n ** 18n, {
      answer: 1n,
      decimals: 8,
      updatedAt: Math.floor(Date.now() / 1000),
      feedAddress: usdc,
      asset: usdc,
      source: "chainlink",
    });

    model.seedFromOnChainSnapshot({
      account: "0x0000000000000000000000000000000000000001",
      blockNumber: 1n,
      eModeCategoryId: 0,
      healthFactorWad: 0n,
      totalCollateralBase: 0n,
      totalDebtBase: 0n,
      liquidationThreshold: 7800n,
      reserves: [
        { asset: weth, scaledCollateral: 10n ** 18n, scaledDebt: 0n },
        { asset: usdc, scaledCollateral: 0n, scaledDebt: 5n * 10n ** 5n },
      ],
    });

    const position = model.positions.get("0x0000000000000000000000000000000000000001")!;
    // Force local recompute (seed may have used aggregate HF path with healthFactorWad 0)
    position.cachedHfWad = 0n;
    const result = model.recomputeHf(position, Math.floor(Date.now() / 1000));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    // collateral 1 WETH * $1 * 7800/10000 = 0.78; debt 0.5 USDC * $1 = 0.5; HF = 0.78/0.5 * 1e18
    expect(result.hf).toBe((7800n * 10n ** 18n) / 5000n);
  });

  it("uses eMode category LT when asset is in collateral bitmap", () => {
    const model = makeModel();
    model.markPricesBootstrapped();
    model.registerReserve(weth, 7800n, 18);
    model.registerReserve(usdc, 7800n, 6);
    model.setReserveId(weth, 1);
    model.setEModeCategory({
      categoryId: 1,
      ltvBps: 9000n,
      liquidationThresholdBps: 9300n,
      liquidationBonus: 10200n,
      collateralBitmap: 1n << 1n, // reserve id 1 = WETH
    });
    model.registerBootstrapPrice(weth, 10n ** 18n, {
      answer: 1n,
      decimals: 8,
      updatedAt: Math.floor(Date.now() / 1000),
      feedAddress: weth,
      asset: weth,
      source: "chainlink",
    });
    model.registerBootstrapPrice(usdc, 10n ** 18n, {
      answer: 1n,
      decimals: 8,
      updatedAt: Math.floor(Date.now() / 1000),
      feedAddress: usdc,
      asset: usdc,
      source: "chainlink",
    });

    model.seedFromOnChainSnapshot({
      account: "0x0000000000000000000000000000000000000002",
      blockNumber: 1n,
      eModeCategoryId: 1,
      healthFactorWad: 0n,
      totalCollateralBase: 0n,
      totalDebtBase: 0n,
      liquidationThreshold: 9300n,
      reserves: [
        { asset: weth, scaledCollateral: 10n ** 18n, scaledDebt: 0n },
        { asset: usdc, scaledCollateral: 0n, scaledDebt: 5n * 10n ** 5n },
      ],
    });

    const position = model.positions.get("0x0000000000000000000000000000000000000002")!;
    const result = model.recomputeHf(position, Math.floor(Date.now() / 1000));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    // eMode LT 9300 instead of base 7800
    expect(result.hf).toBe((9300n * 10n ** 18n) / 5000n);
  });

  it("keeps base LT when eMode asset is not in collateral bitmap", () => {
    const model = makeModel();
    model.markPricesBootstrapped();
    model.registerReserve(weth, 7800n, 18);
    model.registerReserve(usdc, 7800n, 6);
    model.setReserveId(weth, 1);
    model.setEModeCategory({
      categoryId: 1,
      ltvBps: 9000n,
      liquidationThresholdBps: 9300n,
      liquidationBonus: 10200n,
      collateralBitmap: 1n << 5n, // different reserve
    });
    model.registerBootstrapPrice(weth, 10n ** 18n, {
      answer: 1n,
      decimals: 8,
      updatedAt: Math.floor(Date.now() / 1000),
      feedAddress: weth,
      asset: weth,
      source: "chainlink",
    });
    model.registerBootstrapPrice(usdc, 10n ** 18n, {
      answer: 1n,
      decimals: 8,
      updatedAt: Math.floor(Date.now() / 1000),
      feedAddress: usdc,
      asset: usdc,
      source: "chainlink",
    });

    model.seedFromOnChainSnapshot({
      account: "0x0000000000000000000000000000000000000003",
      blockNumber: 1n,
      eModeCategoryId: 1,
      healthFactorWad: 0n,
      totalCollateralBase: 0n,
      totalDebtBase: 0n,
      liquidationThreshold: 7800n,
      reserves: [
        { asset: weth, scaledCollateral: 10n ** 18n, scaledDebt: 0n },
        { asset: usdc, scaledCollateral: 0n, scaledDebt: 5n * 10n ** 5n },
      ],
    });

    const position = model.positions.get("0x0000000000000000000000000000000000000003")!;
    const result = model.recomputeHf(position, Math.floor(Date.now() / 1000));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.hf).toBe((7800n * 10n ** 18n) / 5000n);
  });

  it("does not overwrite hydrated LT when registerReserve is called without LT", () => {
    const model = makeModel();
    model.registerReserve(weth, 7800n);
    model.registerReserve(weth);
    expect(model.reserveConfig.get(weth.toLowerCase())?.liquidationThresholdBps).toBe(7800n);
  });
});
