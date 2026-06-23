import type { Address } from "viem";
import type { EventPurityConfig } from "../config/eventPurityConfig";
import { hfThresholdToWad } from "../config/eventPurityConfig";
import { FEED_HEARTBEATS, MAX_UINT256 } from "../config/oracleBootstrap";
import type { LoggerLike } from "../bot";
import { calculateHealthFactor } from "../protocols/aaveV3";
import type { ParsedAavePoolEvent, ParsedChainlinkPriceEvent } from "./aaveEventParser";

export type PositionConfidence = "high" | "low";
export type PositionTier = "healthy" | "watch" | "urgent" | "liquidatable";

const WAD = 1_000_000_000_000_000_000n;
const BPS = 10_000n;
const BASE_LT_BPS = 8500n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_FEED_DECIMALS = 8;

export { MAX_HF_WAD } from "../config/oracleBootstrap";

export interface FeedState {
  answer: bigint;
  decimals: number;
  updatedAt: number;
  feedAddress: Address;
  asset: Address;
}

export type HfResult =
  | { status: "ok"; hf: bigint }
  | { status: "price_incomplete"; missingAssets: Address[] }
  | { status: "price_stale"; staleAssets: Address[] }
  | { status: "no_debt"; hf: typeof MAX_UINT256 }
  | { status: "error"; reason: string };

export interface ReserveConfig {
  readonly asset: Address;
  liquidationThresholdBps: bigint;
  liquidityIndex: bigint;
  variableBorrowIndex: bigint;
  indexUpdatedAtBlock: bigint;
  liquidationBonus: bigint | null;
}

export interface UserPosition {
  readonly account: Address;
  collateral: Map<string, bigint>;
  debt: Map<string, bigint>;
  collateralIndexAtUpdate: Map<string, bigint>;
  debtIndexAtUpdate: Map<string, bigint>;
  cachedHfWad: bigint;
  confidence: PositionConfidence;
  isFullySeeded: boolean;
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
  readonly reserveAllowlist?: readonly Address[];
  readonly logger?: LoggerLike;
}

export interface TierChange {
  readonly account: Address;
  readonly tier: PositionTier;
  readonly localHfWad: bigint;
  readonly isNew: boolean;
  readonly isFullySeeded: boolean;
}

export interface AaveEventApplyResult {
  readonly changes: readonly TierChange[];
  readonly firstTouchReconcile?: Address;
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
  readonly feedStates = new Map<string, FeedState>();
  readonly reserveConfig = new Map<string, ReserveConfig>();
  private readonly allowlistSet: ReadonlySet<string> | undefined;
  private flashblockTickCount = 0n;
  private evictionTotal = 0;
  private _pricesBootstrapped = false;

  public constructor(private readonly config: LocalPositionModelConfig) {
    if (config.reserveAllowlist !== undefined && config.reserveAllowlist.length > 0) {
      this.allowlistSet = new Set(config.reserveAllowlist.map((addr) => addr.toLowerCase()));
    } else {
      this.allowlistSet = undefined;
    }
  }

  public isPricesBootstrapped(): boolean {
    return this._pricesBootstrapped;
  }

  public markPricesBootstrapped(): void {
    this._pricesBootstrapped = true;
  }

  public registerPriceFeed(_feed: Address, asset: Address, initialPrice: bigint): void {
    this.prices.set(asset.toLowerCase(), initialPrice);
  }

  public registerBootstrapPrice(
    asset: Address,
    normalizedPrice: bigint,
    feedState: FeedState,
  ): void {
    const key = asset.toLowerCase();
    this.prices.set(key, normalizedPrice);
    this.feedStates.set(key, feedState);
  }

  public setReserveLiquidationBonus(asset: Address, bonus: bigint | null): void {
    const key = asset.toLowerCase();
    const reserve = this.reserveConfig.get(key);
    if (reserve === undefined) {
      this.reserveConfig.set(key, {
        asset,
        liquidationThresholdBps: BASE_LT_BPS,
        liquidityIndex: WAD,
        variableBorrowIndex: WAD,
        indexUpdatedAtBlock: 0n,
        liquidationBonus: bonus,
      });
      return;
    }
    this.reserveConfig.set(key, { ...reserve, liquidationBonus: bonus });
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
        liquidationBonus: null,
      });
    }
  }

  public onFlashblockTick(_blockNumber: bigint): boolean {
    this.flashblockTickCount += 1n;
    return this.flashblockTickCount % this.config.purity.reserveIndexRefreshBlocks === 0n;
  }

  public isFullySeeded(account: Address): boolean {
    return this.positions.get(account.toLowerCase())?.isFullySeeded ?? false;
  }

  public removePosition(account: Address): void {
    this.positions.delete(account.toLowerCase());
  }

  public tierChangeForAccount(account: Address, isNew: boolean): TierChange | undefined {
    const position = this.positions.get(account.toLowerCase());
    if (position === undefined) {
      return undefined;
    }
    return this.toTierChange(position, isNew);
  }

  public applyAaveEvent(event: ParsedAavePoolEvent): AaveEventApplyResult {
    if (event.name === "ReserveDataUpdated") {
      this.registerReserve(event.reserve);
      this.applyReserveIndexUpdate(event);
      return { changes: [] };
    }

    const account = resolveUserAddress(event);
    if (account === undefined) {
      return { changes: [] };
    }

    const accountKey = account.toLowerCase();
    const existing = this.positions.get(accountKey);
    if (existing === undefined && !this.isReserveInAllowlist(event.reserve)) {
      return { changes: [] };
    }

    this.registerReserve(event.reserve);
    const isNew = existing === undefined;
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

    if (!this.positions.has(accountKey)) {
      return { changes: [] };
    }

    if (!position.isFullySeeded) {
      this.enforceHardCap(event.meta.blockNumber);
      return { changes: [], firstTouchReconcile: account };
    }

    const hfResult = this.applyHfResult(position, isNew);
    this.enforceHardCap(event.meta.blockNumber);
    return hfResult;
  }

  public applyPriceEvent(event: ParsedChainlinkPriceEvent): readonly TierChange[] {
    const answer = event.price;
    const assetKey = event.asset.toLowerCase();

    if (answer <= 0n) {
      this.config.logger?.error("FEED_INVALID_PRICE", { asset: event.asset, feed: event.feed, answer: answer.toString() });
      return [];
    }

    const existingFeedState = this.feedStates.get(assetKey);
    const decimals = existingFeedState?.decimals ?? DEFAULT_FEED_DECIMALS;
    if (existingFeedState === undefined) {
      this.config.logger?.warn("feed_state_missing_for_price_event", {
        asset: event.asset,
        feed: event.feed,
        usingDefaultDecimals: DEFAULT_FEED_DECIMALS,
      });
    }

    const normalizedPrice = answer * 10n ** BigInt(18 - decimals);
    this.prices.set(assetKey, normalizedPrice);

    const nowSec = Math.floor(Date.now() / 1000);
    if (existingFeedState !== undefined) {
      this.feedStates.set(assetKey, {
        ...existingFeedState,
        answer,
        updatedAt: nowSec,
      });
    }

    const changes: TierChange[] = [];
    for (const position of this.positions.values()) {
      if (!position.isFullySeeded || !positionTouchesAsset(position, event.asset)) {
        continue;
      }
      const hfResult = this.recomputeHf(position, nowSec);
      switch (hfResult.status) {
        case "ok":
        case "no_debt":
          position.cachedHfWad = hfResult.hf;
          changes.push(this.toTierChange(position, false));
          break;
        case "price_incomplete":
          this.config.logger?.info("hf_skip_price_incomplete", { missingAssets: hfResult.missingAssets });
          break;
        case "price_stale":
          this.config.logger?.warn("hf_skip_price_stale", { staleAssets: hfResult.staleAssets });
          break;
        case "error":
          this.config.logger?.error("hf_error", { reason: hfResult.reason });
          break;
        default: {
          const _exhaustive: never = hfResult;
          return _exhaustive;
        }
      }
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
    position.isFullySeeded = true;
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
    position.isFullySeeded = true;
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
    this.enforceHardCap(input.blockNumber);
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
      if (!position.isFullySeeded || position.debt.size === 0) {
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

  /**
   * Recomputes local HF from cached prices and reserve config.
   * @param nowSec Real Unix timestamp in seconds — never a block number.
   */
  public recomputeHf(position: UserPosition, nowSec: number): HfResult {
    try {
      if (!this._pricesBootstrapped) {
        const missingAssets = collectPositionAssets(position);
        return { status: "price_incomplete", missingAssets };
      }

      const missingAssets = collectMissingPriceAssets(position, this.prices);
      if (missingAssets.length > 0) {
        return { status: "price_incomplete", missingAssets };
      }

      const staleAssets = collectStalePriceAssets(position, this.feedStates, nowSec);
      if (staleAssets.length > 0) {
        return { status: "price_stale", staleAssets };
      }

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
        // Aave infinite HF sentinel for no-debt positions.
        return { status: "no_debt", hf: MAX_UINT256 };
      }

      return { status: "ok", hf: (weightedCollateral * WAD) / totalDebt };
    } catch (error) {
      return { status: "error", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private applyHfResult(position: UserPosition, isNew: boolean): AaveEventApplyResult {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.recomputeHf(position, nowSec);
    switch (result.status) {
      case "ok":
      case "no_debt":
        position.cachedHfWad = result.hf;
        return { changes: [this.toTierChange(position, isNew)] };
      case "price_incomplete":
        this.config.logger?.info("hf_skip_price_incomplete", { missingAssets: result.missingAssets });
        return { changes: [] };
      case "price_stale":
        this.config.logger?.warn("hf_skip_price_stale", { staleAssets: result.staleAssets });
        return { changes: [] };
      case "error":
        this.config.logger?.error("hf_error", { reason: result.reason });
        return { changes: [] };
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  private isReserveInAllowlist(reserve: Address): boolean {
    if (this.allowlistSet === undefined) {
      return true;
    }
    return this.allowlistSet.has(reserve.toLowerCase());
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
      cachedHfWad: MAX_UINT256,
      confidence: "low",
      isFullySeeded: false,
      lastConfirmedBlock: 0n,
      lastActivityBlock: blockNumber,
      eModeCategoryId: 0,
    };
    this.positions.set(key, created);
    return created;
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
      isFullySeeded: position.isFullySeeded,
    };
  }
}

function collectPositionAssets(position: UserPosition): Address[] {
  const assets: Address[] = [];
  for (const [assetKey, amount] of position.collateral) {
    if (amount > 0n) {
      assets.push(assetKey as Address);
    }
  }
  for (const [assetKey, amount] of position.debt) {
    if (amount > 0n) {
      assets.push(assetKey as Address);
    }
  }
  return assets;
}

function collectMissingPriceAssets(
  position: UserPosition,
  prices: ReadonlyMap<string, bigint>,
): Address[] {
  const missing: Address[] = [];
  const keys = new Set([...position.collateral.keys(), ...position.debt.keys()]);
  for (const assetKey of keys) {
    const collateral = position.collateral.get(assetKey) ?? 0n;
    const debt = position.debt.get(assetKey) ?? 0n;
    if (collateral === 0n && debt === 0n) {
      continue;
    }
    const price = prices.get(assetKey);
    if (price === undefined || price === 1n) {
      missing.push(assetKey as Address);
    }
  }
  return missing;
}

function collectStalePriceAssets(
  position: UserPosition,
  feedStates: ReadonlyMap<string, FeedState>,
  nowSec: number,
): Address[] {
  const stale: Address[] = [];
  const keys = new Set([...position.collateral.keys(), ...position.debt.keys()]);
  for (const assetKey of keys) {
    const collateral = position.collateral.get(assetKey) ?? 0n;
    const debt = position.debt.get(assetKey) ?? 0n;
    if (collateral === 0n && debt === 0n) {
      continue;
    }
    const feedState = feedStates.get(assetKey);
    if (feedState === undefined) {
      continue;
    }
    const heartbeat = FEED_HEARTBEATS[feedState.feedAddress.toLowerCase()] ?? 3600;
    const staleThreshold = heartbeat * 1.5;
    if (nowSec - feedState.updatedAt > staleThreshold) {
      stale.push(assetKey as Address);
    }
  }
  return stale;
}

function resolveUserAddress(event: ParsedAavePoolEvent): Address | undefined {
  const raw = event.name === "LiquidationCall"
    ? event.user
    : event.onBehalfOf ?? event.user;
  if (raw === undefined) {
    return undefined;
  }
  if (raw.toLowerCase() === ZERO_ADDRESS) {
    return undefined;
  }
  return raw;
}

function positionTouchesAsset(position: UserPosition, asset: Address): boolean {
  const key = asset.toLowerCase();
  return (position.collateral.get(key) ?? 0n) > 0n || (position.debt.get(key) ?? 0n) > 0n;
}
