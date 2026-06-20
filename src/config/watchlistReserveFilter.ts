import type { Address, PublicClient } from "viem";
import type { BorrowerSnapshot } from "../monitors/reserveAwareBorrowerCache";
import { uiPoolDataProviderAbi } from "../protocols/uiPoolDataProvider";

export interface AllowlistReserveRow {
  readonly asset: Address;
  readonly scaledCollateral: bigint;
  readonly scaledDebt: bigint;
}

export function reservesTouchAllowlist(
  reserves: readonly AllowlistReserveRow[],
  allowlist: readonly Address[],
): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  const set = new Set(allowlist.map((addr) => addr.toLowerCase()));
  for (const reserve of reserves) {
    const asset = reserve.asset.toLowerCase();
    const hasDebt = reserve.scaledDebt > 0n;
    const hasCollateral = reserve.scaledCollateral > 0n;
    if ((hasDebt || hasCollateral) && set.has(asset)) {
      return true;
    }
  }
  return false;
}

export function snapshotTouchesAllowlist(
  snapshot: BorrowerSnapshot,
  allowlist: ReadonlySet<string>,
): boolean {
  if (allowlist.size === 0) {
    return true;
  }
  for (const reserve of snapshot.reserves) {
    const asset = reserve.assetAddress.toLowerCase();
    const hasDebt = reserve.variableDebt.raw > 0n || reserve.stableDebt.raw > 0n;
    const hasCollateral = reserve.collateralBalance.raw > 0n;
    if ((hasDebt || hasCollateral) && allowlist.has(asset)) {
      return true;
    }
  }
  return false;
}

export function filterSnapshotsByAllowlist(
  snapshots: readonly BorrowerSnapshot[],
  allowlist: readonly Address[],
): BorrowerSnapshot[] {
  if (allowlist.length === 0) {
    return [...snapshots];
  }
  const set = new Set(allowlist.map((addr) => addr.toLowerCase()));
  return snapshots.filter((snapshot) => snapshotTouchesAllowlist(snapshot, set));
}

export async function filterAccountsTouchingReserveAllowlist(input: {
  readonly client: PublicClient;
  readonly uiPoolDataProvider: Address;
  readonly poolAddressesProvider: Address;
  readonly accounts: readonly Address[];
  readonly allowlist: readonly Address[];
  readonly batchSize?: number;
}): Promise<Set<string>> {
  if (input.allowlist.length === 0) {
    return new Set(input.accounts.map((account) => account.toLowerCase()));
  }
  const allowed = new Set<string>();
  const batchSize = input.batchSize ?? 250;
  for (let i = 0; i < input.accounts.length; i += batchSize) {
    const batch = input.accounts.slice(i, i + batchSize);
    const reserveResults = await input.client.multicall({
      contracts: batch.map((address) => ({
        address: input.uiPoolDataProvider,
        abi: uiPoolDataProviderAbi,
        functionName: "getUserReservesData",
        args: [input.poolAddressesProvider, address],
      })),
      allowFailure: true,
    });
    for (let j = 0; j < batch.length; j += 1) {
      const address = batch[j]!;
      const reserveRow = reserveResults[j];
      if (reserveRow?.status !== "success") {
        continue;
      }
      const reserveData = reserveRow.result as unknown as readonly [
        readonly {
          readonly underlyingAsset: Address;
          readonly scaledATokenBalance: bigint;
          readonly usageAsCollateralEnabledOnUser: boolean;
          readonly scaledVariableDebt: bigint;
        }[],
        number,
      ];
      const reserves: AllowlistReserveRow[] = [];
      for (const row of reserveData[0]) {
        if (row.scaledATokenBalance === 0n && row.scaledVariableDebt === 0n) {
          continue;
        }
        reserves.push({
          asset: row.underlyingAsset,
          scaledCollateral: row.usageAsCollateralEnabledOnUser ? row.scaledATokenBalance : 0n,
          scaledDebt: row.scaledVariableDebt,
        });
      }
      if (reservesTouchAllowlist(reserves, input.allowlist)) {
        allowed.add(address.toLowerCase());
      }
    }
  }
  return allowed;
}
