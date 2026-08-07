import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { ShadowValidator, computeShadowDriftBps } from "../../src/monitors/shadowValidator";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import type { LoggerLike } from "../../src/bot";
import type { Address, PublicClient } from "viem";

const pool = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;
const userNonEmode = "0x1111111111111111111111111111111111111111" as Address;
const userEmode = "0x2222222222222222222222222222222222222222" as Address;

function makeClient(): PublicClient {
  return {
    readContract: vi.fn(async (request: Parameters<PublicClient["readContract"]>[0]) => {
      if (request.functionName === "getUserEMode") {
        const account = request.args?.[0] as Address;
        return account === userEmode ? 1n : 0n;
      }
      const account = request.args?.[0] as Address;
      if (account === userEmode) {
        return [0n, 1_000n, 0n, 8_500n, 8_500n, 900_000_000_000_000_000n];
      }
      return [0n, 1_000n, 0n, 8_500n, 8_500n, 900_000_000_000_000_000n];
    }),
  } as unknown as PublicClient;
}

describe("shadowValidator segmented metrics", () => {
  const purity = parseEventPurityConfig({
    SHADOW_DRIFT_TOLERANCE_BPS: "50",
    SHADOW_FN_RATE_TARGET_PCT: "1.0",
  });
  let model: LocalPositionModel;
  let logger: LoggerLike;

  beforeEach(() => {
    model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
    });
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  it("buckets drift and false negatives by eMode category", async () => {
    const shadow = new ShadowValidator({
      client: makeClient(),
      poolAddress: pool,
      model,
      purity,
      logger,
    });

    await shadow.sample(userNonEmode, 1_200_000_000_000_000_000n, 100n);
    await shadow.sample(userEmode, 1_040_000_000_000_000_000n, 101n);

    const snapshot = shadow.getMetricsSnapshot();
    expect(snapshot.nonEMode.sampleCount).toBe(1);
    expect(snapshot.eMode.sampleCount).toBe(1);
    expect(snapshot.shadowDriftNonEModeBps).toBeGreaterThan(0);
    expect(snapshot.shadowDriftEModeBps).toBeGreaterThan(0);
    expect(snapshot.nonEMode.falseNegativeCount).toBe(1);
    expect(snapshot.eMode.falseNegativeCount).toBe(0);
    expect(snapshot.tuningBucket).toBe("non_eMode_fresh");
  });

  it("logs aggregate fields with segmented metric names", async () => {
    const shadow = new ShadowValidator({
      client: makeClient(),
      poolAddress: pool,
      model,
      purity,
      logger,
    });
    await shadow.sample(userNonEmode, 1_200_000_000_000_000_000n, 100n);
    shadow.logMetricsSnapshot("test");

    const aggregateCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === "shadow_validation_aggregate");
    expect(aggregateCall).toBeDefined();
    expect(aggregateCall?.[1]).toMatchObject({
      shadow_drift_non_eMode_bps: expect.any(Number),
      shadow_drift_eMode_bps: expect.any(Number),
      shadow_drift_fresh_bps: expect.any(Number),
      shadow_drift_stale_bps: expect.any(Number),
      shadow_fn_rate_non_eMode_pct: expect.any(Number),
      shadow_fn_rate_eMode_pct: expect.any(Number),
      shadow_drift_by_asset: expect.any(Array),
      tuningBucket: "non_eMode_fresh",
    });
  });

  it("attributes drift to position assets in aggregate output", async () => {
    const weth = "0x4200000000000000000000000000000000000006" as Address;
    model.markPricesBootstrapped();
    model.registerBootstrapPrice(weth, 3_000_000_000_000_000_000n, {
      answer: 300_000_000_000n,
      decimals: 8,
      updatedAt: Math.floor(Date.now() / 1000),
      feedAddress: "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70",
      asset: weth,
    });
    model.seedFromOnChainSnapshot({
      account: userNonEmode,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_100_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [{ asset: weth, scaledCollateral: 1_000n, scaledDebt: 0n }],
    });

    const shadow = new ShadowValidator({
      client: makeClient(),
      poolAddress: pool,
      model,
      purity,
      logger,
    });
    await shadow.sample(userNonEmode, 1_200_000_000_000_000_000n, 100n);

    const snapshot = shadow.getMetricsSnapshot();
    expect(snapshot.driftByAsset.length).toBeGreaterThan(0);
    expect(snapshot.driftByAsset[0]?.asset.toLowerCase()).toBe(weth.toLowerCase());
  });

  it("logs missing assets when shadow sampling is skipped for price gaps", async () => {
    model.markPricesBootstrapped();
    const shadow = new ShadowValidator({
      client: makeClient(),
      poolAddress: pool,
      model,
      purity,
      logger,
    });
    model.seedFromOnChainSnapshot({
      account: userNonEmode,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 985_667_837_263_193_100n,
      totalCollateralBase: 51_444n,
      totalDebtBase: 41_859n,
      liquidationThreshold: 8_500n,
      reserves: [{
        asset: "0x4200000000000000000000000000000000000006",
        scaledCollateral: 1_000n,
        scaledDebt: 0n,
      }],
    });

    await shadow.maybeSample(userNonEmode, 100n);
    const skipCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "shadow_sample_skipped" && call[1]?.reason === "price_incomplete",
    );
    expect(skipCall).toBeDefined();
    expect(skipCall?.[1]?.missingAssets?.length).toBeGreaterThan(0);
  });

  it("enforces shadow concurrency cap", async () => {
    const cappedPurity = parseEventPurityConfig({
      SHADOW_DRIFT_TOLERANCE_BPS: "50",
      SHADOW_FN_RATE_TARGET_PCT: "1.0",
      SHADOW_MAX_CONCURRENCY: "1",
      SHADOW_SAMPLE_RATE: "1",
      SHADOW_BOOTSTRAP_RAMP_MS: "1",
      SHADOW_BOOTSTRAP_SAMPLE_RATE_MULTIPLIER: "1",
    });
    model.markPricesBootstrapped();
    model.registerBootstrapPrice(
      "0x4200000000000000000000000000000000000006" as Address,
      3_000_000_000_000_000_000n,
      {
        answer: 300_000_000_000n,
        decimals: 8,
        updatedAt: Math.floor(Date.now() / 1000),
        feedAddress: "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70",
        asset: "0x4200000000000000000000000000000000000006" as Address,
      },
    );
    model.seedFromOnChainSnapshot({
      account: userNonEmode,
      blockNumber: 10n,
      eModeCategoryId: 0,
      healthFactorWad: 1_100_000_000_000_000_000n,
      totalCollateralBase: 1_000n,
      totalDebtBase: 100n,
      liquidationThreshold: 8_500n,
      reserves: [{
        asset: "0x4200000000000000000000000000000000000006" as Address,
        scaledCollateral: 1_000n,
        scaledDebt: 0n,
      }],
    });

    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const gatedClient = {
      readContract: vi.fn(async (request: Parameters<PublicClient["readContract"]>[0]) => {
        if (request.functionName === "getUserEMode") {
          return 0n;
        }
        await gate;
        return [0n, 1_000n, 0n, 8_500n, 8_500n, 900_000_000_000_000_000n];
      }),
    } as unknown as PublicClient;

    const shadow = new ShadowValidator({
      client: gatedClient,
      poolAddress: pool,
      model,
      purity: cappedPurity,
      logger,
      startedAtMs: Date.now() - 1_000_000,
    });

    const first = shadow.maybeSample(userNonEmode, 100n);
    const second = shadow.maybeSample(userNonEmode, 101n);
    expect(shadow.getQueueDepth()).toBe(1);
    releaseFirst?.();
    await first;
    await second;
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[0] === "shadow_sample_skipped" && call[1]?.reason === "concurrency_cap",
    )).toBe(true);
  });

  it("returns undefined when on-chain read fails instead of throwing", async () => {
    const failingClient = {
      readContract: vi.fn(async () => {
        throw new Error("rpc_rate_limited");
      }),
    } as unknown as PublicClient;
    const shadow = new ShadowValidator({
      client: failingClient,
      poolAddress: pool,
      model,
      purity,
      logger,
    });

    const result = await shadow.sample(userNonEmode, 1_200_000_000_000_000_000n, 100n);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "shadow_sample_rpc_failed",
      expect.objectContaining({ account: userNonEmode }),
    );
  });

  it("caps drift bps for billion-HF local vs near-liquidatable on-chain", () => {
    const drift = computeShadowDriftBps(9_800_000_000n * 1_000_000_000_000_000_000n, 990_000_000_000_000_000n);
    expect(drift).toBe(10_000);
  });
});
