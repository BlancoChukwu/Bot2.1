import type { Address } from "viem";
import type { AaveReservePair, ChainConfig } from "./chains";
import { selectReservePairMatchingAssets } from "./chains";

export interface ReservePairAccountHint {
  readonly totalCollateralBase: bigint;
  readonly totalDebtBase: bigint;
  readonly collateralAsset?: Address;
  readonly debtAsset?: Address;
}

/**
 * Prefer an exact configured pair when assets are known.
 * Otherwise keep WETH/USDC (pair[0]) unless the account is collateral-heavy,
 * in which case pick the highest configured bonus.
 */
export function selectBestReservePairForAccount(
  chain: ChainConfig,
  account: ReservePairAccountHint,
): AaveReservePair {
  const pairs = chain.aave.reservePairs;
  const first = pairs[0];
  if (first === undefined) {
    throw new Error(`No Aave reserve pairs configured for ${chain.name}`);
  }

  if (account.collateralAsset !== undefined && account.debtAsset !== undefined) {
    const matched = selectReservePairMatchingAssets(pairs, account.collateralAsset, account.debtAsset);
    if (matched !== undefined) {
      return matched;
    }
  }

  const collateralHeavy = account.totalCollateralBase > account.totalDebtBase * 2n;
  const sorted = [...pairs].sort((left, right) => {
    const bonusDiff = right.liquidationBonusBps - left.liquidationBonusBps;
    if (bonusDiff !== 0) {
      return bonusDiff;
    }
    return right.repayValueUsd - left.repayValueUsd;
  });
  return collateralHeavy ? sorted[0] ?? first : first;
}
