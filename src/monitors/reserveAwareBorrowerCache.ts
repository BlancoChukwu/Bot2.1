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
  readonly protocol?: "aave" | "moonwell" | "morpho";
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
  private readonly reserveToAccounts = new Map<string, Set<Address>>();
  private readonly chainCounts = new Map<SupportedChain, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  public constructor(config: { readonly maxEntries?: number; readonly ttlMs?: number } = {}) {
    this.maxEntries = config.maxEntries ?? 50_000;
    this.ttlMs = config.ttlMs ?? 30 * 60_000;
  }

  public upsert(snapshot: BorrowerSnapshot): void {
    const key = cacheKey(snapshot.chain, snapshot.account);
    const previous = this.snapshots.get(key);
    if (previous !== undefined) {
      this.detachReserveIndex(previous);
    } else {
      this.chainCounts.set(snapshot.chain, (this.chainCounts.get(snapshot.chain) ?? 0) + 1);
    }
    this.snapshots.set(key, snapshot);
    this.attachReserveIndex(snapshot);
    this.prune(Date.now());
  }

  public size(chain: SupportedChain): number {
    return this.chainCounts.get(chain) ?? 0;
  }

  public get(chain: SupportedChain, account: Address): BorrowerSnapshot | undefined {
    return this.snapshots.get(cacheKey(chain, account));
  }

  public listAccounts(chain: SupportedChain): Address[] {
    return this.listSnapshots(chain).map((snapshot) => snapshot.account);
  }

  public listSnapshots(chain: SupportedChain): BorrowerSnapshot[] {
    this.prune(Date.now());
    return [...this.snapshots.values()].filter((snapshot) => snapshot.chain === chain);
  }

  public listAccountsForReserve(chain: SupportedChain, reserve: Address): Address[] {
    this.prune(Date.now());
    const indexed = this.reserveToAccounts.get(reserveKey(chain, reserve));
    return indexed === undefined ? [] : [...indexed];
  }

  private prune(nowMs: number): void {
    const ttlEligibleFloorMs = 1_500_000_000_000;
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.updatedAtMs < ttlEligibleFloorMs) {
        continue;
      }
      if (nowMs - snapshot.updatedAtMs <= this.ttlMs) {
        continue;
      }
      this.deleteSnapshot(key, snapshot);
    }
    while (this.snapshots.size > this.maxEntries) {
      const oldest = this.snapshots.entries().next().value as [string, BorrowerSnapshot] | undefined;
      if (oldest === undefined) {
        break;
      }
      this.deleteSnapshot(oldest[0], oldest[1]);
    }
  }

  private deleteSnapshot(key: string, snapshot: BorrowerSnapshot): void {
    this.snapshots.delete(key);
    this.detachReserveIndex(snapshot);
    const next = (this.chainCounts.get(snapshot.chain) ?? 1) - 1;
    if (next <= 0) {
      this.chainCounts.delete(snapshot.chain);
    } else {
      this.chainCounts.set(snapshot.chain, next);
    }
  }

  private attachReserveIndex(snapshot: BorrowerSnapshot): void {
    for (const reserve of snapshot.reserves) {
      const key = reserveKey(snapshot.chain, reserve.assetAddress);
      const accounts = this.reserveToAccounts.get(key) ?? new Set<Address>();
      accounts.add(snapshot.account);
      this.reserveToAccounts.set(key, accounts);
    }
  }

  private detachReserveIndex(snapshot: BorrowerSnapshot): void {
    for (const reserve of snapshot.reserves) {
      const key = reserveKey(snapshot.chain, reserve.assetAddress);
      const accounts = this.reserveToAccounts.get(key);
      if (accounts === undefined) {
        continue;
      }
      accounts.delete(snapshot.account);
      if (accounts.size === 0) {
        this.reserveToAccounts.delete(key);
      }
    }
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

function reserveKey(chain: SupportedChain, reserve: Address): string {
  return `${chain}:${reserve.toLowerCase()}`;
}
