import type { Address, PublicClient } from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";
import { uiPoolDataProviderAbi } from "../protocols/uiPoolDataProvider";
import type { LoggerLike } from "../bot";
import { reservesTouchAllowlist } from "../config/watchlistReserveFilter";
import type { LocalPositionModel } from "./localPositionModel";

export interface OnChainReserveRow {
  readonly asset: Address;
  readonly scaledCollateral: bigint;
  readonly scaledDebt: bigint;
}

export interface ParsedOnChainAccountSnapshot {
  readonly account: Address;
  readonly eModeCategoryId: number;
  readonly healthFactorWad: bigint;
  readonly totalCollateralBase: bigint;
  readonly totalDebtBase: bigint;
  readonly liquidationThreshold: bigint;
  readonly reserves: readonly OnChainReserveRow[];
}

export async function fetchOnChainAccountSnapshot(input: {
  readonly client: PublicClient;
  readonly poolAddress: Address;
  readonly poolAddressesProvider: Address;
  readonly uiPoolDataProvider: Address;
  readonly account: Address;
}): Promise<ParsedOnChainAccountSnapshot | undefined> {
  const [accountResult, reserveResult] = await Promise.all([
    input.client.readContract({
      address: input.poolAddress,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [input.account],
    }),
    input.client.readContract({
      address: input.uiPoolDataProvider,
      abi: uiPoolDataProviderAbi,
      functionName: "getUserReservesData",
      args: [input.poolAddressesProvider, input.account],
    }),
  ]);

  const accountData = accountResult as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  const totalDebtBase = accountData[1];
  if (totalDebtBase === 0n) {
    return undefined;
  }

  const reserveData = reserveResult as unknown as readonly [
    readonly {
      readonly underlyingAsset: Address;
      readonly scaledATokenBalance: bigint;
      readonly usageAsCollateralEnabledOnUser: boolean;
      readonly stableBorrowRate: bigint;
      readonly scaledVariableDebt: bigint;
    }[],
    number,
  ];

  const reserves: OnChainReserveRow[] = [];
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

  return {
    account: input.account,
    eModeCategoryId: Number(reserveData[1]),
    healthFactorWad: accountData[5],
    totalCollateralBase: accountData[0],
    totalDebtBase,
    liquidationThreshold: accountData[3],
    reserves,
  };
}

export function seedModelFromAccountSnapshot(
  model: LocalPositionModel,
  snapshot: ParsedOnChainAccountSnapshot,
  blockNumber: bigint,
): void {
  for (const row of snapshot.reserves) {
    model.registerReserve(row.asset);
  }
  model.seedFromOnChainSnapshot({
    account: snapshot.account,
    blockNumber,
    eModeCategoryId: snapshot.eModeCategoryId,
    healthFactorWad: snapshot.healthFactorWad,
    totalCollateralBase: snapshot.totalCollateralBase,
    totalDebtBase: snapshot.totalDebtBase,
    liquidationThreshold: snapshot.liquidationThreshold,
    reserves: snapshot.reserves,
  });
}

export async function reconcileAndSeedPosition(input: {
  readonly client: PublicClient;
  readonly model: LocalPositionModel;
  readonly poolAddress: Address;
  readonly poolAddressesProvider: Address;
  readonly uiPoolDataProvider: Address;
  readonly account: Address;
  readonly blockNumber: bigint;
  readonly reserveAllowlist?: readonly Address[];
  readonly logger: LoggerLike;
}): Promise<boolean> {
  try {
    const snapshot = await fetchOnChainAccountSnapshot({
      client: input.client,
      poolAddress: input.poolAddress,
      poolAddressesProvider: input.poolAddressesProvider,
      uiPoolDataProvider: input.uiPoolDataProvider,
      account: input.account,
    });
    if (snapshot === undefined) {
      input.model.removePosition(input.account);
      return false;
    }
    if (input.reserveAllowlist !== undefined
      && input.reserveAllowlist.length > 0
      && !reservesTouchAllowlist(snapshot.reserves, input.reserveAllowlist)) {
      input.model.removePosition(input.account);
      return false;
    }
    seedModelFromAccountSnapshot(input.model, snapshot, input.blockNumber);
    return true;
  } catch (error) {
    input.logger.warn("position_on_chain_reconcile_failed", {
      account: input.account,
      error: String(error),
    });
    return false;
  }
}
