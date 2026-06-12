import { describe, expect, it, vi } from "vitest";
import { runPartialBootstrapSweep } from "../../src/monitors/partialBootstrapSweep";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import type { Address, PublicClient } from "viem";

const pool = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;
const userA = "0x1111111111111111111111111111111111111111" as Address;
const weth = "0x4200000000000000000000000000000000000006" as Address;

describe("partialBootstrapSweep", () => {
  it("reports coverage after seeding users with debt", async () => {
    const purity = parseEventPurityConfig({});
    const model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
    });
    model.registerReserve(weth, 8500n);
    model.registerPriceFeed("0xfeed", weth, 3_000_000_000_000n);

    const client = {
      getBlockNumber: vi.fn(async () => 1_000_000n),
      getLogs: vi.fn(async () => [{
        args: { user: userA, onBehalfOf: userA },
      }]),
      multicall: vi.fn(async ({ contracts }: { contracts: readonly { functionName: string }[] }) => {
        if (contracts[0]?.functionName === "getUserAccountData") {
          return [{ status: "success", result: [1_000n, 500n, 0n, 8_500n, 8_500n, 1_200_000_000_000_000_000n] }];
        }
        return [{
          status: "success",
          result: [[{
            underlyingAsset: weth,
            scaledATokenBalance: 1_000n,
            usageAsCollateralEnabledOnUser: true,
            stableBorrowRate: 0n,
            scaledVariableDebt: 100n,
          }], 0],
        }];
      }),
    } as unknown as PublicClient;

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coverage = await runPartialBootstrapSweep({
      chain: "base",
      client,
      model,
      logger,
      lookbackDays: 7,
      poolAddress: pool,
      chunkBlocks: 10_000n,
      accountBatchSize: 10,
      reserveDataBatchSize: 10,
    });

    expect(coverage.uniqueUsersFromLogs).toBeGreaterThan(0);
    expect(coverage.usersWithDebt).toBe(1);
    expect(coverage.usersSeeded).toBe(1);
    expect(coverage.positionCacheSize).toBe(1);
    expect(coverage.estimatedDebtorCoveragePct).toBe(100);
    expect(coverage.discoverySource).toBe("logs");
    expect(coverage.cacheHit).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      "partial_bootstrap_coverage",
      expect.objectContaining({
        usersSeeded: 1,
        usersWithDebt: 1,
        poolAddress: pool,
      }),
    );
  });
});
