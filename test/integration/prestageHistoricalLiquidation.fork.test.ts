import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { resolveCloseFactorBps } from "../../src/config/closeFactor";
import { parsePrestageConfig } from "../../src/config/prestageConfig";
import { encodeLiquidationRoute } from "../../src/protocols/liquidationFlashLoanReceiver";
import {
  PrestageController,
} from "../../src/monitors/prestagePipeline";
import type { LocalPositionModel, UserPosition } from "../../src/monitors/localPositionModel";
import type { LoggerLike } from "../../src/bot";
import { loadPinnedHistoricalLiquidationCase } from "./helpers/pinnedHistoricalLiquidation";

/**
 * Merge-blocker: drive pinned historical Base liquidation through
 * prestage enter → promote → encode, asserting close-factor and capped calldata.
 * Does not require live anvil — uses fixture sizing + deterministic mocks.
 * Optional anvil extension can be added when FORK_RPC is present.
 */
describe("prestage historical liquidation path (pinned Base fixture)", () => {
  const fixture = loadPinnedHistoricalLiquidationCase();

  it("loads the pinned large-position fixture", () => {
    expect(fixture).toBeDefined();
    expect(fixture!.user).toMatch(/^0x/i);
    expect(fixture!.debtToCover).toBeGreaterThan(0n);
    expect(fixture!.blockNumber).toBe(46_925_615n);
  });

  it("enter → promote → encode applies CF and matches capped debtToCover", async () => {
    if (fixture === undefined) {
      throw new Error("missing test/fixtures/historical-liquidation-base.json");
    }

    const account = fixture.user;
    const closeFactorBps = resolveCloseFactorBps({
      healthFactorWad: fixture.healthFactor,
      collateralUsd: 500_000,
      debtUsd: Number(fixture.debtToCover) / 1e6,
    });
    // Fixture debtToCover is the on-chain (already capped) size. Reconstruct full debt for prep.
    const fullDebtWei = closeFactorBps === 5_000
      ? fixture.debtToCover * 2n
      : fixture.debtToCover;
    const fullDebtUsd = Number(fullDebtWei) / 1e6;

    const positions = new Map<string, UserPosition>();
    positions.set(account.toLowerCase(), {
      account,
      isFullySeeded: true,
      cachedHfWad: 1_015_000_000_000_000_000n,
      lastTotalDebtBase: BigInt(Math.floor(fullDebtUsd * 1e8)),
      lastTotalCollateralBase: BigInt(Math.floor(fullDebtUsd * 2 * 1e8)),
      collateral: new Map(),
      debt: new Map(),
      collateralIndexAtUpdate: new Map(),
      debtIndexAtUpdate: new Map(),
      confidence: "high",
      lastConfirmedBlock: fixture.snapshotBlock,
      seededAtBlock: fixture.snapshotBlock,
      lastActivityBlock: fixture.snapshotBlock,
      eModeCategoryId: 0,
    } as UserPosition);
    const model = { positions } as LocalPositionModel;

    const logger: LoggerLike = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as LoggerLike;

    let now = 1_000_000;
    const ctrl = new PrestageController({
      config: parsePrestageConfig({
        USE_EVENT_WATCHLIST: "true",
        PRESTAGE_TOP_N: "5",
        PRESTAGE_TTL_MS: "15000",
      }),
      model,
      logger,
      chain: "base",
      resolveGasCostUsd: async () => 1,
      resolveFlashFeeBps: async () => 9,
      minDebtUsd: 50,
      minProfitUsd: 1,
      getUserAccountData: async () => ({
        healthFactor: fixture.healthFactor,
        totalDebtBase: BigInt(Math.floor(fullDebtUsd * 1e8)),
        totalCollateralBase: BigInt(Math.floor(fullDebtUsd * 2 * 1e8)),
      }),
      loadPairCandidates: async () => [{
        collateralAsset: fixture.collateralAsset,
        debtAsset: fixture.debtAsset,
        fullDebtUsd,
        fullDebtWei,
        liquidationBonusBps: 500,
        collateralReceivedWei: fixture.liquidatedCollateralAmount,
      }],
      quoteExactInput: async () => fixture.debtToCover,
      nowMs: () => now,
    });

    await ctrl.tick();
    const entry = ctrl.get(account);
    expect(entry).toBeDefined();
    expect(entry!.closeFactorBps).toBe(closeFactorBps);
    expect(entry!.debtToCover).toBe(fixture.debtToCover);

    now += 500;
    const promote = await ctrl.promote(account);
    expect(promote.reusedPayload).toBe(true);
    expect(promote.promoteRefresh).toBe(true);
    expect(promote.coldRebuild).toBe(false);
    expect(promote.entry?.encodeInputs.debtToCover).toBe(fixture.debtToCover);

    const calldata = encodeLiquidationRoute(promote.entry!.encodeInputs);
    expect(calldata).toBe(promote.entry!.encodedParams);
    expect(calldata.startsWith("0x")).toBe(true);

    // Document fixture IDs for ops/docs
    expect({
      blockNumber: fixture.blockNumber.toString(),
      snapshotBlock: fixture.snapshotBlock.toString(),
      user: fixture.user,
      closeFactorBps,
    }).toEqual({
      blockNumber: "46925615",
      snapshotBlock: "46925614",
      user: account,
      closeFactorBps,
    });
  });
});

void (null as unknown as Address);
