import type { Address, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import { LocalPositionModel } from "../../src/monitors/localPositionModel";
import { pollLocalFeedFreshness } from "../../src/monitors/localFeedFreshnessPoll";
import type { OracleFeedRegistry } from "../../src/utils/priceOracleCache";

const weth = "0x4200000000000000000000000000000000000006" as Address;
const wethFeed = "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70" as Address;

describe("pollLocalFeedFreshness", () => {
  it("refreshes feedState.updatedAt from chainlink round data", async () => {
    const purity = parseEventPurityConfig({ POSITION_CACHE_HARD_CAP: "5" });
    const model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    model.registerReserve(weth, 8500n);
    const realNowSec = Math.floor(Date.now() / 1000);
    model.registerBootstrapPrice(weth, 3_000_000_000_000_000_000n, {
      answer: 300_000_000_000n,
      decimals: 8,
      updatedAt: realNowSec - 10_000,
      feedAddress: wethFeed,
      asset: weth,
    });
    model.markPricesBootstrapped();

    const feedRegistry: OracleFeedRegistry = {
      optimism: {},
      arbitrum: {},
      base: {
        [weth]: { feed: wethFeed, priceDecimals: 8 },
      },
    };

    const freshUpdatedAt = BigInt(realNowSec - 120);
    const client = {
      multicall: vi.fn().mockResolvedValue([
        { status: "success", result: [1n, 300_000_000_000n, 0n, freshUpdatedAt, 1n] },
        { status: "success", result: 8 },
      ]),
    } as unknown as PublicClient;

    await pollLocalFeedFreshness({
      client,
      chain: "base",
      model,
      feedRegistry,
      assets: [weth],
    });

    expect(model.feedStates.get(weth.toLowerCase())?.updatedAt).toBe(Number(freshUpdatedAt));
  });

  it("returns no changes when prices are not bootstrapped", async () => {
    const purity = parseEventPurityConfig({ POSITION_CACHE_HARD_CAP: "5" });
    const model = new LocalPositionModel({
      purity,
      urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
      watchHfWad: hfThresholdToWad(purity.localHfWatch),
    });

    const changes = await pollLocalFeedFreshness({
      client: { multicall: vi.fn() } as unknown as PublicClient,
      chain: "base",
      model,
      feedRegistry: { optimism: {}, arbitrum: {}, base: {} },
      assets: [weth],
    });

    expect(changes).toEqual([]);
  });
});
