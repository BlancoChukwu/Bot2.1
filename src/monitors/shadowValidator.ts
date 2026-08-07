import type { Address, PublicClient } from "viem";
import type { EventPurityConfig } from "../config/eventPurityConfig";
import type { LoggerLike } from "../bot";
import { MAX_HF_WAD, type LocalPositionModel, type UserPosition } from "./localPositionModel";
import { computeShadowDriftBps } from "./localPositionHfPolicy";
import {
  collectPositionAssets,
  recordAssetDrift,
  SHADOW_DRIFT_ATTRIBUTION_TOP_N,
  topAssetDriftAttribution,
  type AssetDriftAttribution,
  type DriftBucketAccumulator,
} from "./shadowDriftAttribution";
import { poolEmodeAbi } from "./aaveEmode";
import { aavePoolAbi } from "../protocols/aaveV3";

const WAD = 1_000_000_000_000_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface ShadowSample {
  readonly account: Address;
  readonly localHfWad: bigint;
  readonly onChainHfWad: bigint;
  readonly driftBps: number;
  readonly localTier: string;
  readonly onChainLiquidatable: boolean;
  readonly blockNumber: bigint;
  readonly isEMode: boolean;
  readonly eModeCategoryId: number;
}

export interface ShadowMetricsBucket {
  readonly sampleCount: number;
  readonly falseNegativeCount: number;
  readonly falseNegativeRatePct: number;
  readonly meanDriftBps: number;
  readonly maxDriftBps: number;
  readonly withinDriftTolerance: boolean;
  readonly withinFnRateTarget: boolean;
}

export interface ShadowMetricsSnapshot {
  readonly totalSamples: number;
  readonly nonEMode: ShadowMetricsBucket;
  readonly eMode: ShadowMetricsBucket;
  readonly freshNonEMode: ShadowMetricsBucket;
  readonly staleNonEMode: ShadowMetricsBucket;
  readonly shadowDriftNonEModeBps: number;
  readonly shadowDriftEModeBps: number;
  readonly shadowDriftFreshBps: number;
  readonly shadowDriftStaleBps: number;
  readonly shadowFnRateNonEModePct: number;
  readonly shadowFnRateEModePct: number;
  readonly driftToleranceBps: number;
  readonly fnRateTargetPct: number;
  readonly tuningBucket: "non_eMode_fresh";
  readonly driftByAsset: readonly AssetDriftAttribution[];
}

export interface ShadowValidatorConfig {
  readonly client: PublicClient;
  readonly poolAddress: Address;
  readonly model: LocalPositionModel;
  readonly purity: EventPurityConfig;
  readonly logger: LoggerLike;
  readonly startedAtMs?: number;
}

interface BucketAccumulator {
  sampleCount: number;
  falseNegativeCount: number;
  driftSumBps: number;
  maxDriftBps: number;
}

export class ShadowValidator {
  private samplesToday = 0;
  private dayKey = "";
  private sampleCounter = 0;
  private inFlightSamples = 0;
  private skippedDueToConcurrency = 0;
  private readonly nonEModeBucket: BucketAccumulator = emptyBucket();
  private readonly eModeBucket: BucketAccumulator = emptyBucket();
  /** Tuning mean — chainlink-only / fresh prices (excludes gap-fill / aave / peg). */
  private readonly freshNonEModeBucket: BucketAccumulator = emptyBucket();
  /** Diagnostic — gap-fill or stale-adjacent price sources. */
  private readonly staleNonEModeBucket: BucketAccumulator = emptyBucket();
  private readonly assetDriftBuckets = new Map<string, DriftBucketAccumulator>();
  private lastAggregateLogAt = 0;
  private readonly startedAtMs: number;

  public constructor(private readonly config: ShadowValidatorConfig) {
    this.startedAtMs = config.startedAtMs ?? Date.now();
  }

  public getQueueDepth(): number {
    return this.inFlightSamples;
  }

  public maybeSample(account: Address, blockNumber: bigint, nowSec?: number): Promise<ShadowSample | undefined> {
    const position = this.config.model.positions.get(account.toLowerCase());
    if (position === undefined) {
      return Promise.resolve(undefined);
    }

    const sampledAtSec = nowSec ?? Math.floor(Date.now() / 1000);
    const hfResult = this.config.model.recomputeHf(position, sampledAtSec);
    if (hfResult.status === "price_incomplete") {
      this.config.logger.info("shadow_sample_skipped", {
        account,
        reason: "price_incomplete",
        missingCount: hfResult.missingAssets.length,
        missingAssets: hfResult.missingAssets.slice(0, 8),
        blockNumber: Number(blockNumber),
      });
      return Promise.resolve(undefined);
    }
    if (hfResult.status === "price_stale") {
      this.config.logger.info("shadow_sample_skipped", {
        account,
        reason: "price_stale",
        blockNumber: Number(blockNumber),
      });
      return Promise.resolve(undefined);
    }

    const localHfWad = this.config.model.resolveEffectiveHfForTier(position, hfResult);
    if (localHfWad === undefined) {
      this.config.logger.info("shadow_sample_skipped", {
        account,
        reason: hfResult.status,
        blockNumber: Number(blockNumber),
      });
      return Promise.resolve(undefined);
    }

    const skipReason = this.skipReason(account, localHfWad);
    if (skipReason !== undefined) {
      this.config.logger.info("shadow_sample_skipped", {
        account,
        reason: skipReason,
        blockNumber: Number(blockNumber),
      });
      return Promise.resolve(undefined);
    }
    this.sampleCounter += 1;
    const effectiveSampleRate = this.effectiveSampleRate();
    if (this.sampleCounter % effectiveSampleRate !== 0) {
      return Promise.resolve(undefined);
    }
    if (this.inFlightSamples >= this.config.purity.shadowMaxConcurrency) {
      this.skippedDueToConcurrency += 1;
      if (this.skippedDueToConcurrency === 1 || this.skippedDueToConcurrency % 100 === 0) {
        this.config.logger.info("shadow_sample_skipped", {
          account,
          reason: "concurrency_cap",
          inFlight: this.inFlightSamples,
          maxConcurrency: this.config.purity.shadowMaxConcurrency,
          skippedTotal: this.skippedDueToConcurrency,
          blockNumber: Number(blockNumber),
        });
      }
      return Promise.resolve(undefined);
    }
    return this.sample(account, localHfWad, blockNumber);
  }

  private effectiveSampleRate(): number {
    const rampMs = this.config.purity.shadowBootstrapRampMs;
    if (Date.now() - this.startedAtMs >= rampMs) {
      return this.config.purity.shadowSampleRate;
    }
    return this.config.purity.shadowSampleRate * this.config.purity.shadowBootstrapSampleRateMultiplier;
  }

  private skipReason(account: Address, localHfWad: bigint): string | undefined {
    if (!this.config.model.isPricesBootstrapped()) {
      return "prices_not_bootstrapped";
    }
    if (account.toLowerCase() === ZERO_ADDRESS) {
      return "zero_address";
    }
    if (!this.config.model.isFullySeeded(account)) {
      return "not_fully_seeded";
    }
    if (localHfWad >= MAX_HF_WAD) {
      return "max_hf_sentinel";
    }
    return undefined;
  }

  public async sample(account: Address, localHfWad: bigint, blockNumber: bigint): Promise<ShadowSample | undefined> {
    this.resetDailyBudget();
    if (this.samplesToday >= this.config.purity.shadowMaxSamplesPerDay) {
      return undefined;
    }
    this.samplesToday += 1;
    this.inFlightSamples += 1;

    let accountData: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
    let eModeRaw: bigint;
    try {
      [accountData, eModeRaw] = await Promise.all([
        this.config.client.readContract({
          address: this.config.poolAddress,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [account],
        }),
        this.config.client.readContract({
          address: this.config.poolAddress,
          abi: poolEmodeAbi,
          functionName: "getUserEMode",
          args: [account],
        }).catch(() => 0n),
      ]);
    } catch (error) {
      this.config.logger.warn("shadow_sample_rpc_failed", {
        account,
        blockNumber: Number(blockNumber),
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      this.inFlightSamples = Math.max(0, this.inFlightSamples - 1);
    }

    const eModeCategoryId = Number(eModeRaw);
    const isEMode = eModeCategoryId > 0;
    const onChainHfWad = accountData[5];
    const driftBps = computeShadowDriftBps(localHfWad, onChainHfWad);
    const localTier = this.config.model.classifyTier(localHfWad);
    const onChainLiquidatable = onChainHfWad < WAD;
    const isFalseNegative = onChainLiquidatable && (localTier === "healthy" || localTier === "watch");

    const bucket = isEMode ? this.eModeBucket : this.nonEModeBucket;
    bucket.sampleCount += 1;
    bucket.driftSumBps += driftBps;
    if (driftBps > bucket.maxDriftBps) {
      bucket.maxDriftBps = driftBps;
    }
    if (isFalseNegative) {
      bucket.falseNegativeCount += 1;
    }

    const position = this.config.model.positions.get(account.toLowerCase());
    const priceMeta = resolvePositionPriceMeta(this.config.model, position, Math.floor(Date.now() / 1000));
    if (!isEMode) {
      const priceBucket = priceMeta.freshForTuning ? this.freshNonEModeBucket : this.staleNonEModeBucket;
      priceBucket.sampleCount += 1;
      priceBucket.driftSumBps += driftBps;
      if (driftBps > priceBucket.maxDriftBps) {
        priceBucket.maxDriftBps = driftBps;
      }
      if (isFalseNegative) {
        priceBucket.falseNegativeCount += 1;
      }
    }

    if (position !== undefined) {
      recordAssetDrift(
        this.assetDriftBuckets,
        collectPositionAssets(position),
        driftBps,
      );
    }

    const result: ShadowSample = {
      account,
      localHfWad,
      onChainHfWad,
      driftBps,
      localTier,
      onChainLiquidatable,
      blockNumber,
      isEMode,
      eModeCategoryId,
    };
    const sampleAssets = position === undefined ? [] : collectPositionAssets(position);
    this.config.logger.info("shadow_validation_sample", {
      account: result.account,
      localHf: Number(localHfWad) / 1e18,
      onChainHf: Number(onChainHfWad) / 1e18,
      driftBps: result.driftBps,
      localTier: result.localTier,
      onChainLiquidatable: result.onChainLiquidatable,
      blockNumber: Number(blockNumber),
      isEMode: result.isEMode,
      eModeCategoryId: result.eModeCategoryId,
      priceAgeMs: priceMeta.priceAgeMs,
      priceSource: priceMeta.priceSource,
      freshForTuning: priceMeta.freshForTuning,
      // Asset list enables post-hoc correlation of max-drift spikes across pairs.
      assets: sampleAssets,
    });

    if (bucket.sampleCount % 25 === 0) {
      this.logMetricsSnapshot("periodic");
    }
    return result;
  }

  public getFalseNegativeTotal(): number {
    return this.nonEModeBucket.falseNegativeCount + this.eModeBucket.falseNegativeCount;
  }

  public getMetricsSnapshot(): ShadowMetricsSnapshot {
    const driftToleranceBps = this.config.purity.shadowDriftToleranceBps;
    const fnRateTargetPct = this.config.purity.shadowFnRateTargetPct;
    const nonEMode = finalizeBucket(this.nonEModeBucket, driftToleranceBps, fnRateTargetPct);
    const eMode = finalizeBucket(this.eModeBucket, driftToleranceBps, fnRateTargetPct);
    const freshNonEMode = finalizeBucket(this.freshNonEModeBucket, driftToleranceBps, fnRateTargetPct);
    const staleNonEMode = finalizeBucket(this.staleNonEModeBucket, driftToleranceBps, fnRateTargetPct);
    return {
      totalSamples: nonEMode.sampleCount + eMode.sampleCount,
      nonEMode,
      eMode,
      freshNonEMode,
      staleNonEMode,
      shadowDriftNonEModeBps: nonEMode.meanDriftBps,
      shadowDriftEModeBps: eMode.meanDriftBps,
      shadowDriftFreshBps: freshNonEMode.meanDriftBps,
      shadowDriftStaleBps: staleNonEMode.meanDriftBps,
      shadowFnRateNonEModePct: nonEMode.falseNegativeRatePct,
      shadowFnRateEModePct: eMode.falseNegativeRatePct,
      driftToleranceBps,
      fnRateTargetPct,
      tuningBucket: "non_eMode_fresh",
      driftByAsset: topAssetDriftAttribution(this.assetDriftBuckets, SHADOW_DRIFT_ATTRIBUTION_TOP_N),
    };
  }

  public logMetricsSnapshot(reason: string): void {
    const snapshot = this.getMetricsSnapshot();
    const now = Date.now();
    if (reason === "periodic" && now - this.lastAggregateLogAt < 60_000) {
      return;
    }
    this.lastAggregateLogAt = now;
    this.config.logger.info("shadow_validation_aggregate", {
      reason,
      totalSamples: snapshot.totalSamples,
      tuningBucket: snapshot.tuningBucket,
      shadow_drift_non_eMode_bps: snapshot.shadowDriftNonEModeBps,
      shadow_drift_eMode_bps: snapshot.shadowDriftEModeBps,
      shadow_drift_fresh_bps: snapshot.shadowDriftFreshBps,
      shadow_drift_stale_bps: snapshot.shadowDriftStaleBps,
      shadow_fn_rate_non_eMode_pct: snapshot.shadowFnRateNonEModePct,
      shadow_fn_rate_eMode_pct: snapshot.shadowFnRateEModePct,
      non_eMode_sample_count: snapshot.nonEMode.sampleCount,
      eMode_sample_count: snapshot.eMode.sampleCount,
      fresh_non_eMode_sample_count: snapshot.freshNonEMode.sampleCount,
      stale_non_eMode_sample_count: snapshot.staleNonEMode.sampleCount,
      non_eMode_false_negative_count: snapshot.nonEMode.falseNegativeCount,
      eMode_false_negative_count: snapshot.eMode.falseNegativeCount,
      non_eMode_max_drift_bps: snapshot.nonEMode.maxDriftBps,
      eMode_max_drift_bps: snapshot.eMode.maxDriftBps,
      non_eMode_within_drift_tolerance: snapshot.freshNonEMode.withinDriftTolerance,
      non_eMode_within_fn_target: snapshot.nonEMode.withinFnRateTarget,
      drift_tolerance_bps: snapshot.driftToleranceBps,
      fn_rate_target_pct: snapshot.fnRateTargetPct,
      shadow_drift_by_asset_counting: "per_sample_unique_assets",
      shadow_drift_by_asset: snapshot.driftByAsset,
    });
  }

  private resetDailyBudget(): void {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.samplesToday = 0;
    }
  }
}

function emptyBucket(): BucketAccumulator {
  return {
    sampleCount: 0,
    falseNegativeCount: 0,
    driftSumBps: 0,
    maxDriftBps: 0,
  };
}

function finalizeBucket(
  bucket: BucketAccumulator,
  driftToleranceBps: number,
  fnRateTargetPct: number,
): ShadowMetricsBucket {
  const meanDriftBps = bucket.sampleCount === 0 ? 0 : bucket.driftSumBps / bucket.sampleCount;
  const falseNegativeRatePct = bucket.sampleCount === 0
    ? 0
    : (bucket.falseNegativeCount / bucket.sampleCount) * 100;
  return {
    sampleCount: bucket.sampleCount,
    falseNegativeCount: bucket.falseNegativeCount,
    falseNegativeRatePct,
    meanDriftBps,
    maxDriftBps: bucket.maxDriftBps,
    withinDriftTolerance: meanDriftBps <= driftToleranceBps,
    withinFnRateTarget: falseNegativeRatePct <= fnRateTargetPct,
  };
}

/**
 * Fresh-for-tuning = all position assets priced from chainlink (not aave/peg gap-fill).
 * priceAgeMs = max age across feeds; priceSource = dominant / worst source label.
 */
function resolvePositionPriceMeta(
  model: LocalPositionModel,
  position: UserPosition | undefined,
  nowSec: number,
): { readonly priceAgeMs: number; readonly priceSource: string; readonly freshForTuning: boolean } {
  if (position === undefined) {
    return { priceAgeMs: 0, priceSource: "unknown", freshForTuning: false };
  }
  const assets = collectPositionAssets(position);
  let maxAgeSec = 0;
  let freshForTuning = assets.length > 0;
  const sources = new Set<string>();
  for (const asset of assets) {
    const feed = model.feedStates.get(asset.toLowerCase());
    if (feed === undefined) {
      freshForTuning = false;
      sources.add("missing");
      continue;
    }
    const source = feed.source ?? "unknown";
    sources.add(source);
    if (source !== "chainlink") {
      freshForTuning = false;
    }
    maxAgeSec = Math.max(maxAgeSec, Math.max(0, nowSec - feed.updatedAt));
  }
  return {
    priceAgeMs: maxAgeSec * 1_000,
    priceSource: [...sources].sort().join(",") || "unknown",
    freshForTuning,
  };
}

export { computeShadowDriftBps } from "./localPositionHfPolicy";
