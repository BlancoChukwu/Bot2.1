import { describe, expect, it, vi } from "vitest";
import { bootstrapAaveOracleGapFill } from "../../src/oracle/aaveOraclePrice";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import { BASE_AAVE } from "../../src/oracle/baseReserveAssets";
import type { Address, PublicClient } from "viem";

const user = "0x1111111111111111111111111111111111111111" as Address;

describe("bootstrapAaveOracleGapFill", () => {
  it("fills any blind position asset via Aave oracle, not only static allowlist", async () => {
    const purity = parseEventPurityConfig({});
    const model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
    });
    model.markPricesBootstrapped();
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_100_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [{ asset: BASE_AAVE, scaledCollateral: 1_000n, scaledDebt: 0n }],
    });

    const client = {
      multicall: vi.fn(async () => ([{
        status: "success",
        result: 250_000_000n,
      }])),
    } as unknown as PublicClient;

    const info = vi.fn();
    const result = await bootstrapAaveOracleGapFill({
      client,
      model,
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });

    expect(result.warmed).toBe(1);
    expect(result.failed).toEqual([]);
    expect(model.prices.get(BASE_AAVE.toLowerCase())).toBe(2_500_000_000_000_000_000n);
    expect(info).toHaveBeenCalledWith(
      "oracle_gap_fill_start",
      expect.objectContaining({ targetCount: 1 }),
    );
    expect(info).toHaveBeenCalledWith(
      "oracle_bootstrap_coverage",
      expect.objectContaining({
        blind_asset_addresses: [],
      }),
    );
  });
});
