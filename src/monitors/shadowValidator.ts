import type { Address, PublicClient } from "viem";
import type { EventPurityConfig } from "../config/eventPurityConfig";
import type { LoggerLike } from "../bot";
import type { LocalPositionModel } from "./localPositionModel";
import { poolEmodeAbi } from "./aaveEmode";
import { aavePoolAbi } from "../protocols/aaveV3";

const WAD = 1_000_000_000_000_000_000n;

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
  readonly shadowDriftNonEModeBps: number;
  readonly shadowDriftEModeBps: number;
  readonly shadowFnRateNonEModePct: number;
  readonly shadowFnRateEModePct: number;
  readonly driftToleranceBps: number;
  readonly fnRateTargetPct: number;
  readonly tuningBucket: "non_eMode";
}

export interface ShadowValidatorConfig {
  readonly client: PublicClient;
  readonly poolAddress: Address;
  readonly model: LocalPositionModel;
  readonly purity: EventPurityConfig;
  readonly logger: LoggerLike;
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
  private readonly nonEModeBucket: BucketAccumulator = emptyBucket();
  private readonly eModeBucket: BucketAccumulator = emptyBucket();
  private lastAggregateLogAt = 0;

  public constructor(private readonly config: ShadowValidatorConfig) {}

  public maybeSample(account: Address, localHfWad: bigint, blockNumber: bigint): Promise<ShadowSample | undefined> {
    this.sampleCounter += 1;
    if (this.sampleCounter % this.config.purity.shadowSampleRate !== 0) {
      return Promise.resolve(undefined);
    }
    return this.sample(account, localHfWad, blockNumber);
  }

  public async sample(account: Address, localHfWad: bigint, blockNumber: bigint): Promise<ShadowSample | undefined> {
    this.resetDailyBudget();
    if (this.samplesToday >= this.config.purity.shadowMaxSamplesPerDay) {
      return undefined;
    }
    this.samplesToday += 1;

    const [accountData, eModeRaw] = await Promise.all([
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

    const eModeCategoryId = Number(eModeRaw);
    const isEMode = eModeCategoryId > 0;
    const onChainHfWad = accountData[5];
    const driftBps = computeDriftBps(localHfWad, onChainHfWad);
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
    return {
      totalSamples: nonEMode.sampleCount + eMode.sampleCount,
      nonEMode,
      eMode,
      shadowDriftNonEModeBps: nonEMode.meanDriftBps,
      shadowDriftEModeBps: eMode.meanDriftBps,
      shadowFnRateNonEModePct: nonEMode.falseNegativeRatePct,
      shadowFnRateEModePct: eMode.falseNegativeRatePct,
      driftToleranceBps,
      fnRateTargetPct,
      tuningBucket: "non_eMode",
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
      shadow_fn_rate_non_eMode_pct: snapshot.shadowFnRateNonEModePct,
      shadow_fn_rate_eMode_pct: snapshot.shadowFnRateEModePct,
      non_eMode_sample_count: snapshot.nonEMode.sampleCount,
      eMode_sample_count: snapshot.eMode.sampleCount,
      non_eMode_false_negative_count: snapshot.nonEMode.falseNegativeCount,
      eMode_false_negative_count: snapshot.eMode.falseNegativeCount,
      non_eMode_max_drift_bps: snapshot.nonEMode.maxDriftBps,
      eMode_max_drift_bps: snapshot.eMode.maxDriftBps,
      non_eMode_within_drift_tolerance: snapshot.nonEMode.withinDriftTolerance,
      non_eMode_within_fn_target: snapshot.nonEMode.withinFnRateTarget,
      drift_tolerance_bps: snapshot.driftToleranceBps,
      fn_rate_target_pct: snapshot.fnRateTargetPct,
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

function computeDriftBps(localHfWad: bigint, onChainHfWad: bigint): number {
  if (onChainHfWad === 0n) {
    return 10_000;
  }
  const diff = localHfWad > onChainHfWad ? localHfWad - onChainHfWad : onChainHfWad - localHfWad;
  return Number((diff * 10_000n) / onChainHfWad);
}
