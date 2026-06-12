import type { Address } from "viem";
import type { EventPurityConfig } from "../config/eventPurityConfig";
import { hfThresholdToWad } from "../config/eventPurityConfig";
import { calculateHealthFactor } from "../protocols/aaveV3";
import type { ParsedAavePoolEvent, ParsedChainlinkPriceEvent } from "./aaveEventParser";

export type PositionConfidence = "high" | "low";
export type PositionTier = "healthy" | "watch" | "urgent" | "liquidatable";

const WAD = 1_000_000_000_000_000_000n;
const BPS = 10_000n;
const BASE_LT_BPS = 8500n;

export interface ReserveConfig {
  readonly asset: Address;
  liquidationThresholdBps: bigint;
  liquidityIndex: bigint;
  variableBorrowIndex: bigint;
  indexUpdatedAtBlock: bigint;
}

export interface UserPosition {
  readonly account: Address;
  collateral: Map<string, bigint>;
  debt: Map<string, bigint>;
  collateralIndexAtUpdate: Map<string, bigint>;
  debtIndexAtUpdate: Map<string, bigint>;
  cachedHfWad: bigint;
  confidence: PositionConfidence;
  lastConfirmedBlock: bigint;
  lastActivityBlock: bigint;
  eModeCategoryId: number;
  lastTotalCollateralBase?: bigint;
  lastTotalDebtBase?: bigint;
  lastLiquidationThreshold?: bigint;
}

export interface LocalPositionModelConfig {
  readonly purity: EventPurityConfig;
  readonly urgentHfWad: bigint;
  readonly watchHfWad: bigint;
}

export interface TierChange {
  readonly account: Address;
  readonly tier: PositionTier;
  readonly localHfWad: bigint;
  readonly isNew: boolean;
}

export interface ExportedBootstrapPosition {
  readonly account: Address;
  readonly eModeCategoryId: number;
  readonly healthFactorWad: string;
  readonly totalCollateralBase: string;
  readonly totalDebtBase: string;
  readonly liquidationThreshold: string;
  readonly reserves: readonly {
    readonly asset: Address;
    readonly scaledCollateral: string;
    readonly scaledDebt: string;
  }[];
}

export class LocalPositionModel {
  readonly positions = new Map<string, UserPosition>();
  readonly prices = new Map<string, bigint>();
  readonly reserveConfig = new Map<string, ReserveConfig>();
  private flashblockTickCount = 0n;
  private evictionTotal = 0;

  public constructor(private readonly config: LocalPositionModelConfig) {}

  public registerPriceFeed(_feed: Address, asset: Address, initialPrice: bigint): void {
    this.prices.set(asset.toLowerCase(), initialPrice);
  }

  public registerReserve(asset: Address, liquidationThresholdBps = BASE_LT_BPS): void {
    const key = asset.toLowerCase();
    if (!this.reserveConfig.has(key)) {
      this.reserveConfig.set(key, {
        asset,
        liquidationThresholdBps,
        liquidityIndex: WAD,
        variableBorrowIndex: WAD,
        indexUpdatedAtBlock: 0n,
      });
    }
  }

  public onFlashblockTick(_blockNumber: bigint): boolean {
    this.flashblockTickCount += 1n;
    return this.flashblockTickCount % this.config.purity.reserveIndexRefreshBlocks === 0n;
  }

  public applyAaveEvent(event: ParsedAavePoolEvent): readonly TierChange[] {
    if (event.name === "ReserveDataUpdated") {
      this.registerReserve(event.reserve);
      this.applyReserveIndexUpdate(event);
      return [];
    }

    const account = resolveUserAddress(event);
    if (account === undefined) {
      return [];
    }

    this.registerReserve(event.reserve);
    const isNew = !this.positions.has(account.toLowerCase());
    const position = this.getOrCreate(account, event.meta.blockNumber);
    position.lastActivityBlock = event.meta.blockNumber;

    switch (event.name) {
      case "Supply":
        if (event.amount !== undefined) {
          this.addCollateral(position, event.reserve, event.amount);
        }
        break;
      case "Withdraw":
        if (event.amount !== undefined) {
          this.subCollateral(position, event.reserve, event.amount);
        }
        break;
      case "Borrow":
        if (event.amount !== undefined) {
          this.addDebt(position, event.reserve, event.amount);
        }
        break;
      case "Repay":
        if (event.amount !== undefined) {
          this.subDebt(position, event.reserve, event.amount);
        }
        break;
      case "LiquidationCall":
        this.applyLiquidation(position, event);
        break;
      default: {
        const _exhaustive: never = event.name;
        return _exhaustive;
      }
    }

    if (!this.positions.has(account.toLowerCase())) {
      return [];
    }
    position.cachedHfWad = this.recomputeHf(position);
    this.enforceHardCap(event.meta.blockNumber);
    return [this.toTierChange(position, isNew)];
  }

  public applyPriceEvent(event: ParsedChainlinkPriceEvent): readonly TierChange[] {
    this.prices.set(event.asset.toLowerCase(), event.price);
    const changes: TierChange[] = [];
    for (const position of this.positions.values()) {
      if (!positionTouchesAsset(position, event.asset)) {
        continue;
      }
      position.cachedHfWad = this.recomputeHf(position);
      changes.push(this.toTierChange(position, false));
    }
    return changes;
  }

  public confirmOnChain(
    account: Address,
    totalCollateralBase: bigint,
    totalDebtBase: bigint,
    liquidationThreshold: bigint,
    healthFactor: bigint,
    blockNumber: bigint,
  eModeCategoryId: number,
): void {
    const position = this.getOrCreate(account, blockNumber);
    position.confidence = "high";
    position.lastConfirmedBlock = blockNumber;
    position.eModeCategoryId = eModeCategoryId;
    position.lastTotalCollateralBase = totalCollateralBase;
    position.lastTotalDebtBase = totalDebtBase;
    position.lastLiquidationThreshold = liquidationThreshold;
    position.cachedHfWad = healthFactor > 0n
      ? healthFactor
      : calculateHealthFactor({
        totalCollateralBase,
        totalDebtBase,
        currentLiquidationThreshold: liquidationThreshold,
      });
  }

  public seedFromOnChainSnapshot(input: {
    readonly account: Address;
    readonly blockNumber: bigint;
    readonly eModeCategoryId: number;
    readonly healthFactorWad: bigint;
    readonly totalCollateralBase: bigint;
    readonly totalDebtBase: bigint;
    readonly liquidationThreshold: bigint;
    readonly reserves: ReadonlyArray<{
      readonly asset: Address;
      readonly scaledCollateral: bigint;
      readonly scaledDebt: bigint;
    }>;
  }): void {
    const position = this.getOrCreate(input.account, input.blockNumber);
    position.collateral.clear();
    position.debt.clear();
    position.collateralIndexAtUpdate.clear();
    position.debtIndexAtUpdate.clear();

    for (const row of input.reserves) {
      const key = row.asset.toLowerCase();
      this.registerReserve(row.asset);
      const reserve = this.reserveConfig.get(key);
      if (reserve === undefined) {
        continue;
      }
      if (row.scaledCollateral > 0n) {
        position.collateral.set(key, row.scaledCollateral);
        position.collateralIndexAtUpdate.set(key, reserve.liquidityIndex);
      }
      if (row.scaledDebt > 0n) {
        position.debt.set(key, row.scaledDebt);
        position.debtIndexAtUpdate.set(key, reserve.variableBorrowIndex);
      }
    }

    position.eModeCategoryId = input.eModeCategoryId;
    position.confidence = "high";
    position.lastConfirmedBlock = input.blockNumber;
    position.lastActivityBlock = input.blockNumber;
    position.lastTotalCollateralBase = input.totalCollateralBase;
    position.lastTotalDebtBase = input.totalDebtBase;
    position.lastLiquidationThreshold = input.liquidationThreshold;
    position.cachedHfWad = input.healthFactorWad > 0n
      ? input.healthFactorWad
      : calculateHealthFactor({
        totalCollateralBase: input.totalCollateralBase,
        totalDebtBase: input.totalDebtBase,
        currentLiquidationThreshold: input.liquidationThreshold,
      });
  }

  public classifyTier(localHfWad: bigint): PositionTier {
    if (localHfWad < WAD) {
      return "liquidatable";
    }
    if (localHfWad <= this.config.urgentHfWad) {
      return "urgent";
    }
    if (localHfWad <= this.config.watchHfWad) {
      return "watch";
    }
    return "healthy";
  }

  public getEvictionTotal(): number {
    return this.evictionTotal;
  }

  public size(): number {
    return this.positions.size;
  }

  public exportBootstrapSnapshots(): readonly ExportedBootstrapPosition[] {
    const out: ExportedBootstrapPosition[] = [];
    for (const position of this.positions.values()) {
      if (position.debt.size === 0) {
        continue;
      }
      const reserves: { asset: Address; scaledCollateral: string; scaledDebt: string }[] = [];
      const assetKeys = new Set([...position.collateral.keys(), ...position.debt.keys()]);
      for (const assetKey of assetKeys) {
        const collateral = position.collateral.get(assetKey) ?? 0n;
        const debt = position.debt.get(assetKey) ?? 0n;
        if (collateral === 0n && debt === 0n) {
          continue;
        }
        reserves.push({
          asset: assetKey as Address,
          scaledCollateral: collateral.toString(),
          scaledDebt: debt.toString(),
        });
      }
      out.push({
        account: position.account,
        eModeCategoryId: position.eModeCategoryId,
        healthFactorWad: position.cachedHfWad.toString(),
        totalCollateralBase: (position.lastTotalCollateralBase ?? 0n).toString(),
        totalDebtBase: (position.lastTotalDebtBase ?? 1n).toString(),
        liquidationThreshold: (position.lastLiquidationThreshold ?? 0n).toString(),
        reserves,
      });
    }
    return out;
  }

  private getOrCreate(account: Address, blockNumber: bigint): UserPosition {
    const key = account.toLowerCase();
    const existing = this.positions.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: UserPosition = {
      account,
      collateral: new Map(),
      debt: new Map(),
      collateralIndexAtUpdate: new Map(),
      debtIndexAtUpdate: new Map(),
      cachedHfWad: (1n << 256n) - 1n,
      confidence: "low",
      lastConfirmedBlock: 0n,
      lastActivityBlock: blockNumber,
      eModeCategoryId: 0,
    };
    this.positions.set(key, created);
    return created;
  }

  private recomputeHf(position: UserPosition): bigint {
    let weightedCollateral = 0n;
    let totalDebt = 0n;

    for (const [assetKey, amount] of position.collateral) {
      const reserve = this.reserveConfig.get(assetKey);
      const price = this.prices.get(assetKey);
      if (reserve === undefined || price === undefined || amount === 0n) {
        continue;
      }
      const scaled = this.scaleCollateralAmount(position, assetKey, amount, reserve);
      weightedCollateral += (scaled * price * reserve.liquidationThresholdBps) / BPS;
    }

    for (const [assetKey, amount] of position.debt) {
      const reserve = this.reserveConfig.get(assetKey);
      const price = this.prices.get(assetKey);
      if (reserve === undefined || price === undefined || amount === 0n) {
        continue;
      }
      const scaled = this.scaleDebtAmount(position, assetKey, amount, reserve);
      totalDebt += scaled * price;
    }

    if (totalDebt === 0n) {
      return (1n << 256n) - 1n;
    }
    return (weightedCollateral * WAD) / totalDebt;
  }

  private scaleCollateralAmount(
    position: UserPosition,
    assetKey: string,
    amount: bigint,
    reserve: ReserveConfig,
  ): bigint {
    const storedIndex = position.collateralIndexAtUpdate.get(assetKey) ?? WAD;
    if (storedIndex === 0n || reserve.liquidityIndex === storedIndex) {
      return amount;
    }
    return (amount * reserve.liquidityIndex) / storedIndex;
  }

  private scaleDebtAmount(
    position: UserPosition,
    assetKey: string,
    amount: bigint,
    reserve: ReserveConfig,
  ): bigint {
    const storedIndex = position.debtIndexAtUpdate.get(assetKey) ?? WAD;
    if (storedIndex === 0n || reserve.variableBorrowIndex === storedIndex) {
      return amount;
    }
    return (amount * reserve.variableBorrowIndex) / storedIndex;
  }

  private addCollateral(position: UserPosition, asset: Address, amount: bigint): void {
    const key = asset.toLowerCase();
    const reserve = this.reserveConfig.get(key);
    const prev = position.collateral.get(key) ?? 0n;
    position.collateral.set(key, prev + amount);
    position.collateralIndexAtUpdate.set(key, reserve?.liquidityIndex ?? WAD);
  }

  private subCollateral(position: UserPosition, asset: Address, amount: bigint): void {
    const key = asset.toLowerCase();
    const prev = position.collateral.get(key) ?? 0n;
    const next = prev > amount ? prev - amount : 0n;
    if (next === 0n) {
      position.collateral.delete(key);
      position.collateralIndexAtUpdate.delete(key);
    } else {
      position.collateral.set(key, next);
    }
  }

  private addDebt(position: UserPosition, asset: Address, amount: bigint): void {
    const key = asset.toLowerCase();
    const reserve = this.reserveConfig.get(key);
    const prev = position.debt.get(key) ?? 0n;
    position.debt.set(key, prev + amount);
    position.debtIndexAtUpdate.set(key, reserve?.variableBorrowIndex ?? WAD);
  }

  private subDebt(position: UserPosition, asset: Address, amount: bigint): void {
    const key = asset.toLowerCase();
    const prev = position.debt.get(key) ?? 0n;
    const next = prev > amount ? prev - amount : 0n;
    if (next === 0n) {
      position.debt.delete(key);
      position.debtIndexAtUpdate.delete(key);
    } else {
      position.debt.set(key, next);
    }
  }

  private applyLiquidation(position: UserPosition, event: ParsedAavePoolEvent): void {
    const debtAsset = event.debtAsset ?? event.reserve;
    const collateralAsset = event.collateralAsset ?? event.reserve;
    if (event.debtToCover !== undefined) {
      this.subDebt(position, debtAsset, event.debtToCover);
    }
    if (event.liquidatedCollateralAmount !== undefined) {
      this.subCollateral(position, collateralAsset, event.liquidatedCollateralAmount);
    }
    if ([...position.debt.values()].every((v) => v === 0n)) {
      this.positions.delete(position.account.toLowerCase());
    }
  }

  private applyReserveIndexUpdate(event: ParsedAavePoolEvent): void {
    const key = event.reserve.toLowerCase();
    const reserve = this.reserveConfig.get(key);
    if (reserve === undefined) {
      return;
    }
    this.reserveConfig.set(key, {
      ...reserve,
      ...(event.liquidityIndex === undefined ? {} : { liquidityIndex: event.liquidityIndex }),
      ...(event.variableBorrowIndex === undefined ? {} : { variableBorrowIndex: event.variableBorrowIndex }),
      indexUpdatedAtBlock: event.meta.blockNumber,
    });
  }

  private enforceHardCap(blockNumber: bigint): void {
    if (this.positions.size <= this.config.purity.positionCacheHardCap) {
      this.evictInactiveHealthy(blockNumber);
      return;
    }
    const sorted = [...this.positions.values()].sort(
      (a, b) => Number(a.lastActivityBlock - b.lastActivityBlock),
    );
    while (this.positions.size > this.config.purity.positionCacheHardCap && sorted.length > 0) {
      const victim = sorted.shift()!;
      this.positions.delete(victim.account.toLowerCase());
      this.evictionTotal += 1;
    }
    this.evictInactiveHealthy(blockNumber);
  }

  private evictInactiveHealthy(blockNumber: bigint): void {
    const hfThreshold = hfThresholdToWad(this.config.purity.positionEvictionHfThreshold);
    for (const [key, position] of this.positions) {
      const inactiveBlocks = blockNumber - position.lastActivityBlock;
      if (position.cachedHfWad >= hfThreshold
        && inactiveBlocks >= this.config.purity.positionEvictionInactiveBlocks) {
        this.positions.delete(key);
        this.evictionTotal += 1;
      }
    }
  }

  private toTierChange(position: UserPosition, isNew: boolean): TierChange {
    return {
      account: position.account,
      tier: this.classifyTier(position.cachedHfWad),
      localHfWad: position.cachedHfWad,
      isNew,
    };
  }
}

function resolveUserAddress(event: ParsedAavePoolEvent): Address | undefined {
  if (event.name === "LiquidationCall") {
    return event.user;
  }
  return event.onBehalfOf ?? event.user;
}

function positionTouchesAsset(position: UserPosition, asset: Address): boolean {
  const key = asset.toLowerCase();
  return (position.collateral.get(key) ?? 0n) > 0n || (position.debt.get(key) ?? 0n) > 0n;
}
