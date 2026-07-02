import type { Address } from "viem";
import type { LocalPositionModel } from "../monitors/localPositionModel";

const PLACEHOLDER_PRICE = 1n;

export interface OracleCoverageSnapshot {
  readonly totalPositionAssets: number;
  readonly coveredAssets: number;
  readonly blindAssets: number;
  readonly coveredPct: number;
  readonly blindPositionCount: number;
  readonly blindAssetAddresses: readonly Address[];
}

export function collectAssetsNeedingGapFill(model: LocalPositionModel): Address[] {
  const needed = new Set<string>();
  for (const assetKey of model.reserveConfig.keys()) {
    const price = model.prices.get(assetKey);
    if (price === undefined || price === PLACEHOLDER_PRICE) {
      needed.add(assetKey);
    }
  }
  for (const position of model.positions.values()) {
    for (const assetKey of [...position.collateral.keys(), ...position.debt.keys()]) {
      const price = model.prices.get(assetKey);
      if (price === undefined || price === PLACEHOLDER_PRICE) {
        needed.add(assetKey);
      }
    }
  }
  return [...needed].map((key) => key as Address);
}

export function collectBlindAssetAddresses(
  model: LocalPositionModel,
  limit = 20,
): readonly Address[] {
  const slotCounts = new Map<string, number>();
  for (const position of model.positions.values()) {
    if (!position.isFullySeeded) {
      continue;
    }
    for (const assetKey of [...position.collateral.keys(), ...position.debt.keys()]) {
      const collateral = position.collateral.get(assetKey) ?? 0n;
      const debt = position.debt.get(assetKey) ?? 0n;
      if (collateral === 0n && debt === 0n) {
        continue;
      }
      const price = model.prices.get(assetKey);
      if (price === undefined || price === PLACEHOLDER_PRICE) {
        slotCounts.set(assetKey, (slotCounts.get(assetKey) ?? 0) + 1);
      }
    }
  }
  return [...slotCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([assetKey]) => assetKey as Address);
}

export function computeOracleCoverage(model: LocalPositionModel): OracleCoverageSnapshot {
  let totalPositionAssets = 0;
  let coveredAssets = 0;
  let blindPositionCount = 0;

  for (const position of model.positions.values()) {
    if (!position.isFullySeeded) {
      continue;
    }
    const assetKeys = new Set([...position.collateral.keys(), ...position.debt.keys()]);
    let positionBlind = false;
    for (const assetKey of assetKeys) {
      const collateral = position.collateral.get(assetKey) ?? 0n;
      const debt = position.debt.get(assetKey) ?? 0n;
      if (collateral === 0n && debt === 0n) {
        continue;
      }
      totalPositionAssets += 1;
      const price = model.prices.get(assetKey);
      if (price !== undefined && price > PLACEHOLDER_PRICE) {
        coveredAssets += 1;
      } else {
        positionBlind = true;
      }
    }
    if (positionBlind) {
      blindPositionCount += 1;
    }
  }

  const blindAssets = totalPositionAssets - coveredAssets;
  const coveredPct = totalPositionAssets === 0
    ? 100
    : (coveredAssets / totalPositionAssets) * 100;

  return {
    totalPositionAssets,
    coveredAssets,
    blindAssets,
    coveredPct,
    blindPositionCount,
    blindAssetAddresses: collectBlindAssetAddresses(model),
  };
}
