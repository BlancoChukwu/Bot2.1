import type { Address, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { OracleFeedRegistry } from "../../src/utils/priceOracleCache";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { runOraclePriceBootstrap } from "../../src/monitors/eventPurityStack";
import {
  BASE_SEQUENCER_UPTIME_FEED,
  CRITICAL_FEEDS,
} from "../../src/config/oracleBootstrap";

const weth = "0x4200000000000000000000000000000000000006" as Address;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const wethFeed = "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70" as Address;
const usdcFeed = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B" as Address;

const blockTimestamp = 1_700_000_000;
const staleUpdatedAt = blockTimestamp - 10_000;
const freshUpdatedAt = blockTimestamp - 60;

function makeRegistry(): OracleFeedRegistry {
  return {
    optimism: {},
    arbitrum: {},
    base: {
      [weth]: { feed: wethFeed, priceDecimals: 8 },
      [usdc]: { feed: usdcFeed, priceDecimals: 8 },
    },
  };
}

function makeModel(): LocalPositionModel {
  const purity = parseEventPurityConfig({});
  return new LocalPositionModel({
    purity,
    urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
    watchHfWad: hfThresholdToWad(purity.localHfWatch),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

function healthySequencerRound(startedAt: number): readonly [bigint, bigint, bigint, bigint, bigint] {
  return [1n, 0n, BigInt(startedAt), BigInt(blockTimestamp), 1n];
}

function buildMulticallSuccess(
  wethAnswer: bigint,
  usdcAnswer: bigint,
  wethUpdatedAt: number,
  usdcUpdatedAt: number,
  wethDecimals = 8,
  usdcDecimals = 8,
  reserveOk = true,
): Array<{ status: "success" | "failure"; result?: unknown }> {
  const wethReserve = reserveOk
    ? {
      decimals: 18n,
      ltv: 8000n,
      liquidationThreshold: 8500n,
      liquidationBonus: 10500n,
      reserveFactor: 1000n,
      usageAsCollateralEnabled: true,
      borrowingEnabled: true,
      stableBorrowRateEnabled: false,
      isActive: true,
      isFrozen: false,
    }
    : undefined;
  const usdcReserve = reserveOk
    ? {
      decimals: 6n,
      ltv: 8000n,
      liquidationThreshold: 8500n,
      liquidationBonus: 10500n,
      reserveFactor: 1000n,
      usageAsCollateralEnabled: true,
      borrowingEnabled: true,
      stableBorrowRateEnabled: false,
      isActive: true,
      isFrozen: false,
    }
    : undefined;

  return [
    { status: "success", result: [1n, wethAnswer, BigInt(freshUpdatedAt), BigInt(wethUpdatedAt), 1n] },
    { status: "success", result: wethDecimals },
    { status: "success", result: [1n, usdcAnswer, BigInt(freshUpdatedAt), BigInt(usdcUpdatedAt), 1n] },
    { status: "success", result: usdcDecimals },
    reserveOk && wethReserve
      ? { status: "success", result: wethReserve }
      : { status: "failure" },
    reserveOk && usdcReserve
      ? { status: "success", result: usdcReserve }
      : { status: "failure" },
  ];
}

function makeClient(input: {
  sequencerRounds?: Array<readonly [bigint, bigint, bigint, bigint, bigint]>;
  multicallResults?: Array<{ status: "success" | "failure"; result?: unknown }>;
}): PublicClient {
  let seqCall = 0;
  return {
    readContract: vi.fn(async ({ address, functionName }) => {
      if (address === BASE_SEQUENCER_UPTIME_FEED && functionName === "latestRoundData") {
        const round = input.sequencerRounds?.[seqCall] ?? healthySequencerRound(blockTimestamp - 7200);
        seqCall += 1;
        return round;
      }
      if (functionName === "latestRoundData") {
        return [1n, 300_000_000_000n, BigInt(freshUpdatedAt), BigInt(freshUpdatedAt), 1n];
      }
      if (functionName === "decimals") {
        return 8;
      }
      return undefined;
    }),
    getBlock: vi.fn(async () => ({ timestamp: BigInt(blockTimestamp) })),
    multicall: vi.fn(async () => input.multicallResults ?? buildMulticallSuccess(
      300_000_000_000n,
      100_000_000n,
      freshUpdatedAt,
      freshUpdatedAt,
    )),
  } as unknown as PublicClient;
}

describe("runOraclePriceBootstrap", () => {
  it("retries sequencer until healthy on attempt 5", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sleepMs = vi.fn(async () => undefined);
    const client = makeClient({
      sequencerRounds: [
        [1n, 1n, BigInt(blockTimestamp - 100), BigInt(blockTimestamp), 1n],
        [1n, 1n, BigInt(blockTimestamp - 100), BigInt(blockTimestamp), 1n],
        [1n, 1n, BigInt(blockTimestamp - 100), BigInt(blockTimestamp), 1n],
        [1n, 1n, BigInt(blockTimestamp - 100), BigInt(blockTimestamp), 1n],
        healthySequencerRound(blockTimestamp - 7200),
      ],
    });
    const model = makeModel();

    const result = await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs,
    });

    expect(sleepMs).toHaveBeenCalledTimes(4);
    expect(result.sequencerHealthy).toBe(true);
    expect(result.pricesBootstrapped).toBe(true);
    expect(model.isPricesBootstrapped()).toBe(true);
  });

  it("retries when sequencer is up but grace period has not elapsed", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sleepMs = vi.fn(async () => undefined);
    const client = makeClient({
      sequencerRounds: [
        healthySequencerRound(blockTimestamp - 100),
        healthySequencerRound(blockTimestamp - 7200),
      ],
    });
    const model = makeModel();

    await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs,
    });

    expect(sleepMs).toHaveBeenCalledTimes(1);
  });

  it("throws fatal error after 5 unhealthy sequencer attempts", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sleepMs = vi.fn(async () => undefined);
    const client = makeClient({
      sequencerRounds: Array.from({ length: 5 }, () => (
        [1n, 1n, BigInt(blockTimestamp), BigInt(blockTimestamp), 1n] as const
      )),
    });
    const model = makeModel();

    await expect(runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs,
    })).rejects.toThrow("SEQUENCER_DOWN_OR_IN_GRACE_PERIOD");

    expect(model.isPricesBootstrapped()).toBe(false);
  });

  it("skips failed Chainlink multicall entries and continues", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const results = buildMulticallSuccess(300_000_000_000n, 100_000_000n, freshUpdatedAt, freshUpdatedAt);
    results[0] = { status: "failure" };
    results[1] = { status: "failure" };
    const client = makeClient({ multicallResults: results });

    const bootstrap = await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "oracle_multicall_subcall_failed",
      expect.objectContaining({ asset: weth }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "feed_bootstrap_read_fallback",
      expect.objectContaining({ asset: weth }),
    );
    expect(bootstrap.pricesBootstrapped).toBe(true);
    expect(model.prices.get(weth.toLowerCase())).not.toBe(1n);
  });

  it("stores liquidationBonus null when reserve config fetch fails", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const results = buildMulticallSuccess(300_000_000_000n, 100_000_000n, freshUpdatedAt, freshUpdatedAt, 8, 8, false);
    const client = makeClient({ multicallResults: results });

    await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(logger.warn).toHaveBeenCalledWith("RESERVE_CONFIG_FETCH_FAILED", expect.objectContaining({ asset: weth }));
    const reserve = model.reserveConfig.get(weth.toLowerCase());
    expect(reserve?.liquidationBonus).toBeNull();
  });

  it("does not register stale feeds", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const client = makeClient({
      multicallResults: buildMulticallSuccess(
        300_000_000_000n,
        100_000_000n,
        staleUpdatedAt,
        freshUpdatedAt,
      ),
    });

    const result = await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(model.feedStates.has(weth.toLowerCase())).toBe(false);
    expect(result.warmCriticalFeeds.has(wethFeed.toLowerCase())).toBe(false);
    expect(result.pricesBootstrapped).toBe(false);
  });

  it("keeps pricesBootstrapped false when a critical feed is stale", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const usdcStaleUpdatedAt = blockTimestamp - 200_000;
    const client = makeClient({
      multicallResults: buildMulticallSuccess(
        300_000_000_000n,
        100_000_000n,
        freshUpdatedAt,
        usdcStaleUpdatedAt,
      ),
    });

    const result = await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(result.warmCriticalFeeds.has(usdcFeed.toLowerCase())).toBe(false);
    expect(result.pricesBootstrapped).toBe(false);
    expect(CRITICAL_FEEDS.every((f) => result.warmCriticalFeeds.has(f.toLowerCase()))).toBe(false);
  });

  it("skips feeds with decimals greater than 18", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const client = makeClient({
      multicallResults: buildMulticallSuccess(
        300_000_000_000n,
        100_000_000n,
        freshUpdatedAt,
        freshUpdatedAt,
        19,
        8,
      ),
    });

    await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(logger.error).toHaveBeenCalledWith(
      "FEED_DECIMAL_OVERFLOW",
      expect.objectContaining({ asset: weth, decimals: 19 }),
    );
    expect(resultWarmOnlyUsdc(model)).toBe(true);
  });

  it("skips feeds with invalid non-positive answers", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const client = makeClient({
      multicallResults: buildMulticallSuccess(
        0n,
        100_000_000n,
        freshUpdatedAt,
        freshUpdatedAt,
      ),
    });

    await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(logger.error).toHaveBeenCalledWith(
      "FEED_INVALID_PRICE",
      expect.objectContaining({ asset: weth }),
    );
  });

  it("uses exactly one multicall for price and reserve fetching", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const client = makeClient({});

    await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(client.multicall).toHaveBeenCalledTimes(1);
    expect(client.multicall).toHaveBeenCalledWith({
      contracts: expect.any(Array),
      allowFailure: true,
    });
  });

  it("falls back to readContract when all Chainlink multicall subcalls fail", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const results = buildMulticallSuccess(300_000_000_000n, 100_000_000n, freshUpdatedAt, freshUpdatedAt);
    results[0] = { status: "failure" };
    results[1] = { status: "failure" };
    results[2] = { status: "failure" };
    results[3] = { status: "failure" };
    const client = makeClient({ multicallResults: results });

    const bootstrap = await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "feed_bootstrap_read_fallback",
      expect.objectContaining({ asset: weth }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "feed_bootstrap_read_fallback",
      expect.objectContaining({ asset: usdc }),
    );
    expect(bootstrap.pricesBootstrapped).toBe(true);
    expect(model.isPricesBootstrapped()).toBe(true);
  });

  it("parses object-shaped latestRoundData from multicall", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const model = makeModel();
    const results = buildMulticallSuccess(300_000_000_000n, 100_000_000n, freshUpdatedAt, freshUpdatedAt);
    results[0] = {
      status: "success",
      result: {
        roundId: 1n,
        answer: 300_000_000_000n,
        startedAt: BigInt(freshUpdatedAt),
        updatedAt: BigInt(freshUpdatedAt),
        answeredInRound: 1n,
      },
    };
    results[2] = {
      status: "success",
      result: {
        roundId: 1n,
        answer: 100_000_000n,
        startedAt: BigInt(freshUpdatedAt),
        updatedAt: BigInt(freshUpdatedAt),
        answeredInRound: 1n,
      },
    };
    const client = makeClient({ multicallResults: results });

    const result = await runOraclePriceBootstrap({
      chain: "base",
      executionClient: client,
      feedRegistry: makeRegistry(),
      model,
      logger,
      sleepMs: async () => undefined,
    });

    expect(result.pricesBootstrapped).toBe(true);
    expect(model.isPricesBootstrapped()).toBe(true);
  });
});

function resultWarmOnlyUsdc(model: LocalPositionModel): boolean {
  return model.feedStates.has(usdc.toLowerCase()) && !model.feedStates.has(weth.toLowerCase());
}
