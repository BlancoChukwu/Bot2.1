import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { parsePrestageConfig } from "../../src/config/prestageConfig";
import {
  PrestageController,
  safePrestageTick,
  type PrestageBumpSource,
} from "../../src/monitors/prestagePipeline";
import type { LocalPositionModel, UserPosition } from "../../src/monitors/localPositionModel";
import type { LoggerLike } from "../../src/bot";

const WAD = 1_000_000_000_000_000_000n;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;

function logger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as LoggerLike;
}

function seedModel(rows: Array<{
  account: Address;
  hf: bigint;
  debtUsd: number;
}>): LocalPositionModel {
  const positions = new Map<string, UserPosition>();
  for (const row of rows) {
    const debtBase = BigInt(Math.floor(row.debtUsd * 1e8));
    positions.set(row.account.toLowerCase(), {
      account: row.account,
      isFullySeeded: true,
      cachedHfWad: row.hf,
      lastTotalDebtBase: debtBase,
      lastTotalCollateralBase: debtBase * 2n,
      collateral: new Map(),
      debt: new Map(),
      collateralIndexAtUpdate: new Map(),
      debtIndexAtUpdate: new Map(),
      confidence: "high",
      lastConfirmedBlock: 0n,
      seededAtBlock: 0n,
      lastActivityBlock: 0n,
      eModeCategoryId: 0,
    } as UserPosition);
  }
  return { positions } as LocalPositionModel;
}

function baseConfig() {
  return parsePrestageConfig({
    USE_EVENT_WATCHLIST: "true",
    PRESTAGE_ENABLED: "true",
    PRESTAGE_HF_UPPER: "1.02",
    PRESTAGE_TOP_N: "2",
    PRESTAGE_TTL_MS: "15000",
    PRESTAGE_MIN_REFRESH_INTERVAL_MS: "1500",
    LIQUIDATION_SWAP_SLIPPAGE_BPS: "200",
  });
}

describe("PrestageController", () => {
  it("only preps top-N survivors (11th never prepped)", async () => {
    const accounts = Array.from({ length: 11 }, (_, i) =>
      (`0x${(i + 1).toString(16).padStart(40, "0")}`) as Address,
    );
    const model = seedModel(accounts.map((account, i) => ({
      account,
      hf: 1_015_000_000_000_000_000n,
      debtUsd: 100_000 - i * 1_000,
    })));
    const loadPairCandidates = vi.fn(async (account: Address) => [{
      collateralAsset: WETH,
      debtAsset: USDC,
      fullDebtUsd: 100_000,
      fullDebtWei: 100_000_000_000n,
      liquidationBonusBps: 500,
      collateralReceivedWei: 1_000_000_000_000_000_000n,
    }]);
    const quoteExactInput = vi.fn(async () => 1_000_000n);
    const ctrl = new PrestageController({
      config: { ...baseConfig(), topN: 10 },
      model,
      logger: logger(),
      chain: "base",
      resolveGasCostUsd: async () => 1,
      resolveFlashFeeBps: async () => 9,
      minDebtUsd: 50,
      minProfitUsd: 1,
      loadPairCandidates,
      quoteExactInput,
      nowMs: () => 1_000_000,
    });
    await ctrl.tick();
    expect(ctrl.size()).toBeLessThanOrEqual(10);
    expect(ctrl.get(accounts[10]!)).toBeUndefined();
    expect(loadPairCandidates.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("cheap filter does not invoke Quoter", async () => {
    const account = "0x00000000000000000000000000000000000000aa" as Address;
    const model = seedModel([{ account, hf: 1_015_000_000_000_000_000n, debtUsd: 10 }]);
    const quoteExactInput = vi.fn(async () => 1n);
    const ctrl = new PrestageController({
      config: baseConfig(),
      model,
      logger: logger(),
      chain: "base",
      resolveGasCostUsd: async () => 5,
      resolveFlashFeeBps: async () => 9,
      minDebtUsd: 50,
      minProfitUsd: 45,
      quoteExactInput,
      nowMs: () => 1_000_000,
    });
    await ctrl.tick();
    expect(quoteExactInput).not.toHaveBeenCalled();
    expect(ctrl.size()).toBe(0);
  });

  it("full-entry invalidates on each bump source", () => {
    const account = "0x00000000000000000000000000000000000000bb" as Address;
    const model = seedModel([{ account, hf: 1_015_000_000_000_000_000n, debtUsd: 50_000 }]);
    const ctrl = new PrestageController({
      config: baseConfig(),
      model,
      logger: logger(),
      chain: "base",
      resolveGasCostUsd: async () => 1,
      resolveFlashFeeBps: async () => 9,
      minDebtUsd: 50,
      minProfitUsd: 1,
      nowMs: () => 1_000_000,
    });
    // Seed cache manually via tick with synthetic pairs
    const sources: PrestageBumpSource[] = [
      "Borrow",
      "Repay",
      "LiquidationCall",
      "ReserveIndexUpdate",
      "OracleFeedSwitch",
      "ConfigReload",
      "OraclePriceMove",
      "TtlExpiry",
      "Manual",
    ];
    for (const source of sources) {
      // force an entry
      (ctrl as unknown as { cache: Map<string, unknown> }).cache.set(account.toLowerCase(), {
        account,
        generation: 1,
      });
      ctrl.invalidate(source === "ReserveIndexUpdate" || source === "OraclePriceMove" || source === "ConfigReload" || source === "OracleFeedSwitch"
        ? undefined
        : account, source);
      expect(ctrl.get(account)).toBeUndefined();
    }
  });

  it("fires min-interval backstop", async () => {
    const account = "0x00000000000000000000000000000000000000cc" as Address;
    const model = seedModel([{ account, hf: 1_015_000_000_000_000_000n, debtUsd: 80_000 }]);
    const log = logger();
    let now = 1_000_000;
    const ctrl = new PrestageController({
      config: baseConfig(),
      model,
      logger: log,
      chain: "base",
      resolveGasCostUsd: async () => 1,
      resolveFlashFeeBps: async () => 9,
      minDebtUsd: 50,
      minProfitUsd: 1,
      loadPairCandidates: async () => [{
        collateralAsset: WETH,
        debtAsset: USDC,
        fullDebtUsd: 80_000,
        fullDebtWei: 80_000_000_000n,
        liquidationBonusBps: 500,
        collateralReceivedWei: 1_000_000_000_000_000_000n,
      }],
      quoteExactInput: async () => 50_000_000n,
      nowMs: () => now,
    });
    await ctrl.tick();
    expect(ctrl.get(account)).toBeDefined();
    now += 400;
    await ctrl.tick();
    expect(log.info).toHaveBeenCalledWith(
      "prestage_refresh_backstop",
      expect.objectContaining({ deferredReason: "min_interval" }),
    );
  });

  it("promote reuses payload without refreshBorrowers on valid cache", async () => {
    const account = "0x00000000000000000000000000000000000000dd" as Address;
    const model = seedModel([{ account, hf: 1_015_000_000_000_000_000n, debtUsd: 15_000_000 }]);
    const refreshBorrowers = vi.fn(async () => undefined);
    const getUserAccountData = vi.fn(async () => ({
      healthFactor: 998_000_000_000_000_000n,
      totalDebtBase: 15_000_000n * 10n ** 8n,
      totalCollateralBase: 30_000_000n * 10n ** 8n,
    }));
    let now = 1_000_000;
    const ctrl = new PrestageController({
      config: baseConfig(),
      model,
      logger: logger(),
      chain: "base",
      resolveGasCostUsd: async () => 1,
      resolveFlashFeeBps: async () => 9,
      minDebtUsd: 50,
      minProfitUsd: 1,
      refreshBorrowers,
      getUserAccountData,
      loadPairCandidates: async () => [{
        collateralAsset: WETH,
        debtAsset: USDC,
        fullDebtUsd: 15_000_000,
        fullDebtWei: 15_000_000_000_000n,
        liquidationBonusBps: 500,
        collateralReceivedWei: 10n ** 18n,
      }],
      quoteExactInput: async () => 7_000_000_000_000n,
      nowMs: () => now,
    });
    await ctrl.tick();
    refreshBorrowers.mockClear();
    now += 800;
    // Drop HF into liquidatable for promote confirm
    const pos = model.positions.get(account.toLowerCase())!;
    (pos as { cachedHfWad: bigint }).cachedHfWad = 998_000_000_000_000_000n;
    const result = await ctrl.promote(account);
    expect(result.reusedPayload).toBe(true);
    expect(result.promoteRefresh).toBe(true);
    expect(result.coldRebuild).toBe(false);
    expect(getUserAccountData).toHaveBeenCalledTimes(1);
    expect(refreshBorrowers).not.toHaveBeenCalled();
    expect(result.entry?.closeFactorBps).toBe(5_000);
  });

  it("failure isolation: killed controller does not block hot path tick wrapper", async () => {
    const account = "0x00000000000000000000000000000000000000ee" as Address;
    const model = seedModel([{ account, hf: 1_015_000_000_000_000_000n, debtUsd: 50_000 }]);
    const log = logger();
    const ctrl = new PrestageController({
      config: baseConfig(),
      model,
      logger: log,
      chain: "base",
      resolveGasCostUsd: async () => {
        throw new Error("boom");
      },
      resolveFlashFeeBps: async () => 9,
      minDebtUsd: 50,
      minProfitUsd: 1,
    });
    await safePrestageTick(ctrl, log, "base");
    expect(log.warn).toHaveBeenCalledWith(
      "prestage_tick_failed_isolated",
      expect.objectContaining({ chain: "base" }),
    );
    ctrl.kill();
    await safePrestageTick(ctrl, log, "base");
    // Hot path continues — no throw
    expect(true).toBe(true);
  });

  it("synthetic $15M HF 1.015→0.998 promote shows reusedPayload", async () => {
    const account = "0x00000000000000000000000000000000000000ff" as Address;
    const model = seedModel([{ account, hf: 1_015_000_000_000_000_000n, debtUsd: 15_000_000 }]);
    let now = 5_000_000;
    const ctrl = new PrestageController({
      config: baseConfig(),
      model,
      logger: logger(),
      chain: "base",
      resolveGasCostUsd: async () => 1,
      resolveFlashFeeBps: async () => 9,
      minDebtUsd: 50,
      minProfitUsd: 1,
      getUserAccountData: async () => ({
        healthFactor: 998_000_000_000_000_000n,
        totalDebtBase: 15_000_000n * 10n ** 8n,
        totalCollateralBase: 30_000_000n * 10n ** 8n,
      }),
      loadPairCandidates: async () => [{
        collateralAsset: WETH,
        debtAsset: USDC,
        fullDebtUsd: 15_000_000,
        fullDebtWei: 15_000_000_000_000n,
        liquidationBonusBps: 500,
        collateralReceivedWei: 10n ** 18n,
      }],
      quoteExactInput: async () => 7_000_000_000_000n,
      nowMs: () => now,
    });
    await ctrl.tick();
    const prepAt = ctrl.get(account)?.builtAtMs;
    now += 500;
    const result = await ctrl.promote(account);
    expect(result.reusedPayload).toBe(true);
    expect(result.promoteRefresh).toBe(true);
    expect(result.prepAtMs).toBe(prepAt);
    expect(result.promoteAtMs).toBeGreaterThan(prepAt!);
    expect(result.entry?.debtToCover).toBe(7_500_000_000_000n);
  });
});

describe("parsePrestageConfig", () => {
  it("defaults enabled when USE_EVENT_WATCHLIST=true", () => {
    const cfg = parsePrestageConfig({ USE_EVENT_WATCHLIST: "true" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.hfUpper).toBe(1.02);
    expect(cfg.topN).toBe(10);
    expect(cfg.minRefreshIntervalMs).toBe(1_500);
    expect(cfg.oracleInvalidateBps).toBe(200);
  });
});

void WAD;
