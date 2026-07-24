import type { Address } from "viem";
import type { EventPurityConfig } from "../config/eventPurityConfig";
import { hfThresholdToWad } from "../config/eventPurityConfig";
import { FEED_HEARTBEATS, MAX_UINT256 } from "../config/oracleBootstrap";
import type { LoggerLike } from "../bot";
import { calculateHealthFactor } from "../protocols/aaveV3";
import type { ParsedAavePoolEvent, ParsedChainlinkPriceEvent } from "./aaveEventParser";
import { resolveHfFromResult } from "./localPositionHfPolicy";
import { HfPriceGapAggregator } from "../utils/logRateLimiter";
import {
  pegAssetsDerivedFrom,
  pegReferenceAsset,
  resolvePegPriceWad18,
} from "../oracle/pegPriceNormalizer";
import { BASE_USDC, BASE_USDBC } from "../oracle/baseReserveAssets";
import {
  filterHealthyPegAssetsFromGapList,
  pegUsdbcPriceFromHealthyReference,
  resolveEffectiveAssetPriceWad18,
  type PegReferenceHealthInput,
} from "../oracle/healthyPegAsset";

export type PositionConfidence = "high" | "low";
export type PositionTier = "healthy" | "watch" | "urgent" | "liquidatable";

const WAD = 1_000_000_000_000_000_000n;
const BPS = 10_000n;
const BASE_LT_BPS = 8500n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_FEED_DECIMALS = 8;

export { MAX_HF_WAD } from "../config/oracleBootstrap";

export type PriceSource = "chainlink" | "aave" | "peg";

export interface FeedState {
  answer: bigint;
  decimals: number;
  updatedAt: number;
  feedAddress: Address;
  asset: Address;
  source?: PriceSource;
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
  /**
   * ERC20 decimals from on-chain `decimals()`. Required before HF.
   * Never invent a default (especially not 18) — missing means fail loud.
   */
  decimals?: number;
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
  /**
   * Block of the on-chain snapshot used to seed this position.
   * Balance-mutating pool events with meta.blockNumber <= seededAtBlock are
   * already reflected in the Maps and must not be re-applied (gap-fill replay).
   */
  seededAtBlock: bigint;
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
  private readonly priceGapAggregator = new HfPriceGapAggregator({ windowSec: 60 });

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

  public registerReserve(
    asset: Address,
    liquidationThresholdBps = BASE_LT_BPS,
    decimals?: number,
  ): void {
    const key = asset.toLowerCase();
    const existing = this.reserveConfig.get(key);
    if (existing === undefined) {
      this.reserveConfig.set(key, {
        asset,
        liquidationThresholdBps,
        liquidityIndex: WAD,
        variableBorrowIndex: WAD,
        indexUpdatedAtBlock: 0n,
        liquidationBonus: null,
        ...(decimals === undefined ? {} : { decimals: assertReserveDecimals(decimals, asset) }),
      });
      return;
    }
    if (decimals !== undefined && existing.decimals === undefined) {
      this.reserveConfig.set(key, {
        ...existing,
        decimals: assertReserveDecimals(decimals, asset),
      });
    }
  }

  /** Cache on-chain ERC20 decimals. Throws on invalid or conflicting values — never defaults to 18. */
  public setReserveDecimals(asset: Address, decimals: number): void {
    const validated = assertReserveDecimals(decimals, asset);
    this.registerReserve(asset);
    const key = asset.toLowerCase();
    const reserve = this.reserveConfig.get(key);
    if (reserve === undefined) {
      throw new Error(`reserve_decimals_missing_config:${asset}`);
    }
    if (reserve.decimals !== undefined && reserve.decimals !== validated) {
      throw new Error(
        `reserve_decimals_conflict:${asset}:have=${reserve.decimals}:got=${validated}`,
      );
    }
    this.reserveConfig.set(key, { ...reserve, decimals: validated });
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
    // Index-only: always apply, including historical gap-fill (no balance mutation).
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

    // Fully-seeded snapshot already includes balance effects through seededAtBlock.
    // Replaying Supply/Borrow/Repay/... at or before that block double-counts.
    // Apply only strictly later events: event.block > seededAtBlock.
    if (
      position.isFullySeeded
      && isBalanceMutatingPoolEvent(event.name)
      && event.meta.blockNumber <= position.seededAtBlock
    ) {
      return { changes: [] };
    }

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

  public applyFeedPriceUpdate(
    asset: Address,
    feed: Address,
    answer: bigint,
    decimals: number,
    updatedAtSec: number,
  ): readonly TierChange[] {
    if (answer <= 0n) {
      this.config.logger?.error("FEED_INVALID_PRICE", {
        asset,
        feed,
        answer: answer.toString(),
      });
      return [];
    }
    if (decimals > 18) {
      this.config.logger?.error("FEED_DECIMAL_OVERFLOW", { asset, feed, decimals });
      return [];
    }

    const assetKey = asset.toLowerCase();
    const normalizedPrice = answer * 10n ** BigInt(18 - decimals);
    this.prices.set(assetKey, normalizedPrice);
    // Tag Chainlink so gap-fill (source=aave/peg) and feed freshness never collide on source.
    this.feedStates.set(assetKey, {
      answer,
      decimals,
      updatedAt: updatedAtSec,
      feedAddress: feed,
      asset,
      source: "chainlink",
    });

    const pegChanges = this.syncDerivedPegPrices(updatedAtSec, asset);
    const directChanges = this.recomputeTierChangesForAsset(asset, updatedAtSec);
    if (pegChanges.length === 0) {
      return directChanges;
    }
    const merged = [...directChanges];
    const seen = new Set(merged.map((change) => change.account.toLowerCase()));
    for (const change of pegChanges) {
      if (!seen.has(change.account.toLowerCase())) {
        merged.push(change);
        seen.add(change.account.toLowerCase());
      }
    }
    return merged;
  }

  /** Keeps 1:1 peg assets (e.g. USDbC) aligned with their reference stable price. */
  public syncDerivedPegPrices(nowSec: number, updatedReferenceAsset?: Address): readonly TierChange[] {
    const pegAssets: Address[] = updatedReferenceAsset !== undefined
      ? [...pegAssetsDerivedFrom(updatedReferenceAsset)]
      : [];
    if (updatedReferenceAsset === undefined) {
      for (const assetKey of this.prices.keys()) {
        const asset = assetKey as Address;
        if (pegReferenceAsset(asset) !== undefined) {
          pegAssets.push(asset);
        }
      }
    }

    const changes: TierChange[] = [];
    for (const pegAsset of pegAssets) {
      const pegKey = pegAsset.toLowerCase();
      const pegPrice = resolvePegPriceWad18(pegAsset, this.prices);
      const reference = pegReferenceAsset(pegAsset);
      if (pegPrice === undefined || reference === undefined) {
        continue;
      }
      if (this.prices.get(pegKey) === pegPrice) {
        continue;
      }
      this.registerBootstrapPrice(pegAsset, pegPrice, {
        answer: pegPrice / 10n ** 10n,
        decimals: 8,
        updatedAt: nowSec,
        feedAddress: reference,
        asset: pegAsset,
        source: "peg",
      });
      changes.push(...this.recomputeTierChangesForAsset(pegAsset, nowSec));
    }
    return changes;
  }

  public applyPriceEvent(event: ParsedChainlinkPriceEvent): readonly TierChange[] {
    const existingFeedState = this.feedStates.get(event.asset.toLowerCase());
    const decimals = existingFeedState?.decimals ?? DEFAULT_FEED_DECIMALS;
    if (existingFeedState === undefined) {
      this.config.logger?.warn("feed_state_missing_for_price_event", {
        asset: event.asset,
        feed: event.feed,
        usingDefaultDecimals: DEFAULT_FEED_DECIMALS,
      });
    }

    const updatedAtSec = event.oracleUpdatedAtSec ?? Math.floor(Date.now() / 1000);
    return this.applyFeedPriceUpdate(
      event.asset,
      event.feed,
      event.price,
      decimals,
      updatedAtSec,
    );
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
    position.seededAtBlock = input.blockNumber;
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

  public evictUnderMemoryPressure(blockNumber: bigint): number {
    const startSize = this.positions.size;
    const pressureCap = Math.floor(this.config.purity.positionCacheHardCap * 0.75);
    const sorted = [...this.positions.values()].sort(
      (a, b) => Number(a.lastActivityBlock - b.lastActivityBlock),
    );
    for (const position of sorted) {
      if (this.positions.size <= pressureCap) {
        break;
      }
      const tier = this.classifyTier(position.cachedHfWad);
      if (tier === "urgent" || tier === "watch" || tier === "liquidatable") {
        continue;
      }
      if (position.cachedHfWad < (3n * WAD) / 2n) {
        continue;
      }
      this.positions.delete(position.account.toLowerCase());
      this.evictionTotal += 1;
    }
    this.evictInactiveHealthy(blockNumber);
    return startSize - this.positions.size;
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
  public resolveEffectiveHfForTier(position: UserPosition, hfResult: HfResult): bigint | undefined {
    return resolveHfFromResult(position, hfResult);
  }

  public recomputeHf(position: UserPosition, nowSec: number): HfResult {
    try {
      if (!this._pricesBootstrapped) {
        const missingAssets = collectPositionAssets(position);
        return { status: "price_incomplete", missingAssets };
      }

      this.syncDerivedPegPrices(nowSec);
      this.materializeHealthyPegPrices(nowSec);

      const healthInput = this.pegHealthInput(nowSec);
      const missingAssets = collectMissingPriceAssets(position, healthInput);
      if (missingAssets.length > 0) {
        return { status: "price_incomplete", missingAssets };
      }

      const staleAssets = collectStalePriceAssets(position, this.feedStates, nowSec);
      if (staleAssets.length > 0) {
        return { status: "price_stale", staleAssets };
      }

      const missingDecimals = collectMissingDecimalsAssets(position, this.reserveConfig);
      if (missingDecimals.length > 0) {
        this.config.logger?.error("RESERVE_DECIMALS_MISSING", {
          account: position.account,
          assets: missingDecimals,
        });
        return {
          status: "error",
          reason: `missing_reserve_decimals:${missingDecimals.join(",")}`,
        };
      }

      let weightedCollateral = 0n;
      let totalDebt = 0n;

      for (const [assetKey, amount] of position.collateral) {
        const reserve = this.reserveConfig.get(assetKey);
        const price = resolveEffectiveAssetPriceWad18(assetKey as Address, healthInput);
        if (reserve === undefined || price === undefined || amount === 0n) {
          continue;
        }
        const decimals = requireReserveDecimals(reserve);
        const scale = 10n ** BigInt(decimals);
        const scaled = this.scaleCollateralAmount(position, assetKey, amount, reserve);
        // Multiply first, divide last — truncating `scaled / 10^decimals` zeros dust legs.
        weightedCollateral += (scaled * price * reserve.liquidationThresholdBps)
          / (BPS * scale);
      }

      for (const [assetKey, amount] of position.debt) {
        const reserve = this.reserveConfig.get(assetKey);
        const price = resolveEffectiveAssetPriceWad18(assetKey as Address, healthInput);
        if (reserve === undefined || price === undefined || amount === 0n) {
          continue;
        }
        const decimals = requireReserveDecimals(reserve);
        const scale = 10n ** BigInt(decimals);
        const scaled = this.scaleDebtAmount(position, assetKey, amount, reserve);
        totalDebt += (scaled * price) / scale;
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

  /**
   * Recompute tiers for positions touching any of `assets` after a gap-fill price write.
   * `registerBootstrapPrice` / `registerAavePrice` update prices+feedStates but do not emit
   * TierChanges — without this, gap-fill-only books stay on stale cached HF until the next
   * Chainlink or Aave event (execution-order / write-gap race with the oracle poll).
   */
  public recomputeTiersForAssets(
    assets: readonly Address[],
    nowSec: number = Math.floor(Date.now() / 1000),
  ): TierChange[] {
    if (assets.length === 0) {
      return [];
    }
    const seen = new Set<string>();
    const changes: TierChange[] = [];
    for (const asset of assets) {
      for (const change of this.recomputeTierChangesForAsset(asset, nowSec)) {
        const key = change.account.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        changes.push(change);
      }
    }
    return changes;
  }

  private recomputeTierChangesForAsset(asset: Address, nowSec: number): TierChange[] {
    const changes: TierChange[] = [];
    for (const position of this.positions.values()) {
      if (!position.isFullySeeded || !positionTouchesAsset(position, asset)) {
        continue;
      }
      const hfResult = this.recomputeHf(position, nowSec);
      const committed = this.commitHfFromRecompute(position, hfResult);
      if (committed !== undefined) {
        changes.push(this.toTierChange(position, false));
      }
      switch (hfResult.status) {
        case "ok":
        case "no_debt":
          break;
        case "price_incomplete": {
          const gapAssets = filterHealthyPegAssetsFromGapList(
            hfResult.missingAssets,
            this.pegHealthInput(nowSec),
          );
          if (gapAssets.length > 0) {
            this.recordPriceGap(position.account, gapAssets);
          }
          break;
        }
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

  private commitHfFromRecompute(position: UserPosition, hfResult: HfResult): bigint | undefined {
    const effective = resolveHfFromResult(position, hfResult);
    if (effective === undefined) {
      return undefined;
    }
    position.cachedHfWad = effective;
    return effective;
  }

  private applyHfResult(position: UserPosition, isNew: boolean): AaveEventApplyResult {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.recomputeHf(position, nowSec);
    const committed = this.commitHfFromRecompute(position, result);
    if (committed !== undefined) {
      return { changes: [this.toTierChange(position, isNew)] };
    }
    switch (result.status) {
      case "ok":
      case "no_debt":
        return { changes: [] };
      case "price_incomplete": {
        const gapAssets = filterHealthyPegAssetsFromGapList(
          result.missingAssets,
          this.pegHealthInput(nowSec),
        );
        if (gapAssets.length > 0) {
          this.recordPriceGap(position.account, gapAssets);
        }
        return { changes: [] };
      }
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
      seededAtBlock: 0n,
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

  private pegHealthInput(nowSec: number): PegReferenceHealthInput {
    return {
      prices: this.prices,
      feedStates: this.feedStates,
      nowSec,
    };
  }

  /** Writes USDbC into the local price map when USDC reference is fresh — no RPC. */
  private materializeHealthyPegPrices(nowSec: number): void {
    const input = this.pegHealthInput(nowSec);
    const pegPrice = pegUsdbcPriceFromHealthyReference(input);
    if (pegPrice === undefined) {
      return;
    }
    const pegKey = BASE_USDBC.toLowerCase();
    if (this.prices.get(pegKey) === pegPrice) {
      return;
    }
    const usdcState = this.feedStates.get(BASE_USDC.toLowerCase());
    this.registerBootstrapPrice(BASE_USDBC, pegPrice, {
      answer: pegPrice / 10n ** 10n,
      decimals: 8,
      updatedAt: usdcState?.updatedAt ?? nowSec,
      feedAddress: BASE_USDC,
      asset: BASE_USDBC,
      source: "peg",
    });
    this.config.logger?.info("usdbc_healthy_peg_materialized_from_usdc", {
      pegAsset: BASE_USDBC,
      referenceAsset: BASE_USDC,
      pegPriceWad18: pegPrice.toString(),
      usdcUpdatedAt: usdcState?.updatedAt ?? nowSec,
    });
  }

  private recordPriceGap(account: Address, missingAssets: readonly Address[]): void {
    const summary = this.priceGapAggregator.record(account, missingAssets);
    if (summary === undefined) {
      return;
    }
    this.config.logger?.info("hf_price_gap_summary", summary);
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

function assertReserveDecimals(decimals: number, asset: Address): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`invalid_reserve_decimals:${asset}:${decimals}`);
  }
  return decimals;
}

function requireReserveDecimals(reserve: ReserveConfig): number {
  if (reserve.decimals === undefined) {
    throw new Error(`missing_reserve_decimals:${reserve.asset}`);
  }
  return reserve.decimals;
}

function collectMissingDecimalsAssets(
  position: UserPosition,
  reserveConfig: ReadonlyMap<string, ReserveConfig>,
): Address[] {
  const missing: Address[] = [];
  for (const assetKey of collectPositionAssets(position)) {
    const reserve = reserveConfig.get(assetKey.toLowerCase());
    if (reserve === undefined || reserve.decimals === undefined) {
      missing.push(assetKey);
    }
  }
  return missing;
}

function collectMissingPriceAssets(
  position: UserPosition,
  input: PegReferenceHealthInput,
): Address[] {
  const missing: Address[] = [];
  const keys = new Set([...position.collateral.keys(), ...position.debt.keys()]);
  for (const assetKey of keys) {
    const collateral = position.collateral.get(assetKey) ?? 0n;
    const debt = position.debt.get(assetKey) ?? 0n;
    if (collateral === 0n && debt === 0n) {
      continue;
    }
    const effectivePrice = resolveEffectiveAssetPriceWad18(assetKey as Address, input);
    if (effectivePrice !== undefined) {
      continue;
    }
    missing.push(assetKey as Address);
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
    if (feedState.source === "aave" || feedState.source === "peg") {
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

function isBalanceMutatingPoolEvent(name: ParsedAavePoolEvent["name"]): boolean {
  switch (name) {
    case "Supply":
    case "Withdraw":
    case "Borrow":
    case "Repay":
    case "LiquidationCall":
      return true;
    case "ReserveDataUpdated":
      return false;
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

function positionTouchesAsset(position: UserPosition, asset: Address): boolean {
  const key = asset.toLowerCase();
  return (position.collateral.get(key) ?? 0n) > 0n || (position.debt.get(key) ?? 0n) > 0n;
}
