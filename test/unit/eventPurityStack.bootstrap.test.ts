import type { Address, PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { EventPurityStack } from "../../src/monitors/eventPurityStack";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";
import type { OracleFeedRegistry } from "../../src/utils/priceOracleCache";

const pool = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;
const user = "0x1111111111111111111111111111111111111111" as Address;
const weth = "0x4200000000000000000000000000000000000006" as Address;
const wethFeed = "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70" as Address;

function makeRegistry(): OracleFeedRegistry {
  return {
    optimism: {},
    arbitrum: {},
    base: {
      [weth]: { feed: wethFeed, priceDecimals: 8 },
    },
  };
}

describe("EventPurityStack bootstrap gating", () => {
  it("does not enqueue urgent confirmations before prices are bootstrapped", async () => {
    const purity = parseEventPurityConfig({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = {} as PublicClient;
    const stack = new EventPurityStack({
      chain: "base",
      poolAddress: pool,
      ingestionWsUrl: "wss://example.invalid",
      executionClient: client,
      feedRegistry: makeRegistry(),
      purity,
      logger,
    });

    const enqueueSpy = vi.spyOn(stack.confirmQueue, "enqueueUrgent");
    const change = {
      account: user,
      tier: "urgent",
      localHfWad: 1_040_000_000_000_000_000n,
      isNew: true,
      isFullySeeded: true,
    };

    await (stack as unknown as {
      handleTierChanges: (changes: typeof change[], blockNumber: bigint) => Promise<void>;
    }).handleTierChanges([change], 100n);

    expect(stack.model.isPricesBootstrapped()).toBe(false);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("enqueues urgent confirmations after prices are bootstrapped", async () => {
    const purity = parseEventPurityConfig({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = {} as PublicClient;
    const stack = new EventPurityStack({
      chain: "base",
      poolAddress: pool,
      ingestionWsUrl: "wss://example.invalid",
      executionClient: client,
      feedRegistry: makeRegistry(),
      purity,
      logger,
    });

    stack.model.markPricesBootstrapped();
    const enqueueSpy = vi.spyOn(stack.confirmQueue, "enqueueUrgent");
    vi.spyOn(stack.confirmQueue, "flushUrgent").mockResolvedValue([]);
    const change = {
      account: user,
      tier: "urgent",
      localHfWad: 1_040_000_000_000_000_000n,
      isNew: true,
      isFullySeeded: true,
    };

    await (stack as unknown as {
      handleTierChanges: (changes: typeof change[], blockNumber: bigint) => Promise<void>;
    }).handleTierChanges([change], 100n);

    expect(enqueueSpy).toHaveBeenCalledWith(user);
  });
});
