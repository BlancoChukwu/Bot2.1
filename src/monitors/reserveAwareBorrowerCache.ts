import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import {
  convertToQuote,
  createAssetAmount,
  type Asset,
  type AssetAmount,
} from "../utils/typedAssetMath";

const liquidationHealthFactor = 1_000_000_000_000_000_000n;

export interface BorrowerSnapshot {
  readonly chain: SupportedChain;
  readonly account: Address;
  readonly healthFactor: bigint;
  readonly reserves: readonly BorrowerReserveSnapshot[];
  readonly updatedAtMs: number;
}

export interface BorrowerReserveSnapshot {
  readonly assetAddress: Address;
  readonly asset: Asset;
  readonly collateralBalance: AssetAmount;
  readonly variableDebt: AssetAmount;
  readonly stableDebt: AssetAmount;
  readonly priceInQuote: AssetAmount;
  readonly usageAsCollateralEnabled: boolean;
  readonly liquidationBonusBps: number;
}

export class ReserveAwareBorrowerCache {
  private readonly snapshots = new Map<string, BorrowerSnapshot>();

  public upsert(snapshot: BorrowerSnapshot): void {
    this.snapshots.set(cacheKey(snapshot.chain, snapshot.account), snapshot);
  }

  public get(chain: SupportedChain, account: Address): BorrowerSnapshot | undefined {
    return this.snapshots.get(cacheKey(chain, account));
  }

  public listAccounts(chain: SupportedChain): Address[] {
    return this.listSnapshots(chain).map((snapshot) => snapshot.account);
  }

  public listSnapshots(chain: SupportedChain): BorrowerSnapshot[] {
    return [...this.snapshots.values()].filter((snapshot) => snapshot.chain === chain);
  }
}

export function createReserveAwareCandidates(
  cache: ReserveAwareBorrowerCache,
  chain: SupportedChain,
): LiquidationCandidate[] {
  return cache.listSnapshots(chain).flatMap((snapshot) => toCandidates(snapshot));
}

function toCandidates(snapshot: BorrowerSnapshot): LiquidationCandidate[] {
  if (snapshot.healthFactor >= liquidationHealthFactor) {
    return [];
  }

  const collaterals = snapshot.reserves.filter(
    (reserve) => reserve.usageAsCollateralEnabled && reserve.collateralBalance.raw > 0n,
  );
  const debts = snapshot.reserves.filter((reserve) => totalDebt(reserve).raw > 0n);
  const bestCollateral = [...collaterals]
    .sort(compareReserveCollateralDescending)[0];
  if (bestCollateral === undefined) {
    return [];
  }

  return debts.map((debtReserve) => {
    const debt = totalDebt(debtReserve);
    return {
      account: snapshot.account,
      collateralAsset: bestCollateral.assetAddress,
      debtAsset: debtReserve.assetAddress,
      debtToCover: debt.raw,
      repayValueUsd: toDecimalNumber(convertToQuote(debt, debtReserve.priceInQuote)),
      liquidationBonusBps: bestCollateral.liquidationBonusBps,
      healthFactor: snapshot.healthFactor,
    };
  });
}

function totalDebt(reserve: BorrowerReserveSnapshot): AssetAmount {
  return createAssetAmount(
    reserve.asset,
    reserve.variableDebt.raw + reserve.stableDebt.raw,
  );
}

function quoteReserveCollateral(reserve: BorrowerReserveSnapshot): AssetAmount {
  return convertToQuote(reserve.collateralBalance, reserve.priceInQuote);
}

function compareReserveCollateralDescending(
  left: BorrowerReserveSnapshot,
  right: BorrowerReserveSnapshot,
): number {
  const leftQuote = quoteReserveCollateral(left).raw;
  const rightQuote = quoteReserveCollateral(right).raw;
  if (leftQuote === rightQuote) {
    return 0;
  }

  return leftQuote > rightQuote ? -1 : 1;
}

function toDecimalNumber(amount: AssetAmount): number {
  return Number(amount.raw) / 10 ** amount.asset.decimals;
}

function cacheKey(chain: SupportedChain, account: Address): string {
  return `${chain}:${account.toLowerCase()}`;
}
