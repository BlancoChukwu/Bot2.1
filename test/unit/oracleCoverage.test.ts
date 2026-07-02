import { describe, expect, it } from "vitest";
import {
  collectBlindAssetAddresses,
  collectAssetsNeedingGapFill,
  computeOracleCoverage,
} from "../../src/oracle/oracleCoverage";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import { BASE_AAVE, BASE_TBTC } from "../../src/oracle/baseReserveAssets";
import type { Address } from "viem";

const user = "0x1111111111111111111111111111111111111111" as Address;

function makeModel(): LocalPositionModel {
  const purity = parseEventPurityConfig({});
  return new LocalPositionModel({
    purity,
    urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
    watchHfWad: hfThresholdToWad(purity.localHfWatch),
  });
}

describe("oracleCoverage", () => {
  it("collects assets needing gap fill from blind position slots", () => {
    const model = makeModel();
    model.markPricesBootstrapped();
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_100_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [
        { asset: BASE_AAVE, scaledCollateral: 1_000n, scaledDebt: 0n },
        { asset: BASE_TBTC, scaledCollateral: 0n, scaledDebt: 500n },
      ],
    });

    const needed = collectAssetsNeedingGapFill(model).map((asset) => asset.toLowerCase());
    expect(needed).toContain(BASE_AAVE.toLowerCase());
    expect(needed).toContain(BASE_TBTC.toLowerCase());
  });

  it("reports blind asset addresses ordered by affected slot count", () => {
    const model = makeModel();
    model.markPricesBootstrapped();
    model.seedFromOnChainSnapshot({
      account: user,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_100_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [
        { asset: BASE_AAVE, scaledCollateral: 1_000n, scaledDebt: 0n },
        { asset: BASE_TBTC, scaledCollateral: 0n, scaledDebt: 500n },
      ],
    });

    const coverage = computeOracleCoverage(model);
    expect(coverage.blindAssets).toBe(2);
    expect(coverage.blindAssetAddresses.map((asset) => asset.toLowerCase())).toEqual(
      expect.arrayContaining([
        BASE_AAVE.toLowerCase(),
        BASE_TBTC.toLowerCase(),
      ]),
    );
  });
});
