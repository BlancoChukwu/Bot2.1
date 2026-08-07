import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import type { LiquidationForkCase } from "./liquidationReceiverForkHarness";

export interface PinnedHistoricalLiquidationFixture {
  readonly chain: string;
  readonly pool: Address;
  readonly user: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly debtToCover: string;
  readonly liquidatedCollateralAmount: string;
  readonly receiveAToken: boolean;
  readonly blockNumber: string;
  readonly snapshotBlock: string;
  readonly healthFactor: string;
}

export function pinnedHistoricalFixturePath(): string {
  return join(process.cwd(), "test", "fixtures", "historical-liquidation-base.json");
}

export function loadPinnedHistoricalLiquidationCase(): LiquidationForkCase | undefined {
  const path = pinnedHistoricalFixturePath();
  if (!existsSync(path)) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as PinnedHistoricalLiquidationFixture;
  return {
    user: raw.user,
    collateralAsset: raw.collateralAsset,
    debtAsset: raw.debtAsset,
    debtToCover: BigInt(raw.debtToCover),
    liquidatedCollateralAmount: BigInt(raw.liquidatedCollateralAmount),
    receiveAToken: raw.receiveAToken,
    blockNumber: BigInt(raw.blockNumber),
    snapshotBlock: BigInt(raw.snapshotBlock),
    healthFactor: BigInt(raw.healthFactor),
  };
}
