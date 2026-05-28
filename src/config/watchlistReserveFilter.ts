import type { Address } from "viem";
import type { BorrowerSnapshot } from "../monitors/reserveAwareBorrowerCache";

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
