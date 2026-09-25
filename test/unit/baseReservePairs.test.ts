import { describe, expect, it } from "vitest";
import { getChainConfig, selectReservePairMatchingAssets } from "../../src/config/chains";
import { selectBestReservePairForAccount } from "../../src/config/reservePairPolicy";

const baseWeth = "0x4200000000000000000000000000000000000006";
const baseUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const baseCbBtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

describe("Base Aave executable reserve pairs", () => {
  it("configures more than WETH/USDC on Base", () => {
    const pairs = getChainConfig("base").aave.reservePairs;
    expect(pairs.length).toBeGreaterThan(1);
    expect(selectReservePairMatchingAssets(pairs, baseWeth, baseUsdc)).toBeDefined();
    expect(selectReservePairMatchingAssets(pairs, baseCbBtc, baseUsdc)?.liquidationBonusBps).toBe(750);
  });

  it("selects a higher-bonus pair when the account is collateral-heavy", () => {
    const pair = selectBestReservePairForAccount(getChainConfig("base"), {
      totalCollateralBase: 10_000n,
      totalDebtBase: 1_000n,
    });
    expect(pair.liquidationBonusBps).toBeGreaterThanOrEqual(750);
  });

  it("uses the exact configured pair when collateral and debt are known", () => {
    const pair = selectBestReservePairForAccount(getChainConfig("base"), {
      totalCollateralBase: 10_000n,
      totalDebtBase: 1_000n,
      collateralAsset: baseCbBtc as `0x${string}`,
      debtAsset: baseUsdc as `0x${string}`,
    });
    expect(pair.collateralAsset.toLowerCase()).toBe(baseCbBtc.toLowerCase());
    expect(pair.debtAsset.toLowerCase()).toBe(baseUsdc.toLowerCase());
  });

  it("keeps WETH/USDC as the first configured pair for conservative fallback", () => {
    const first = getChainConfig("base").aave.reservePairs[0];
    expect(first?.collateralAsset.toLowerCase()).toBe(baseWeth.toLowerCase());
    expect(first?.debtAsset.toLowerCase()).toBe(baseUsdc.toLowerCase());
  });
});
