import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { PriceOracleCache, type OracleFeedRegistry } from "../../src/utils/priceOracleCache";

const chain = "base" as const;
const token = "0x0000000000000000000000000000000000000001" as Address;
const feed = "0x0000000000000000000000000000000000000010" as Address;

function registry(): OracleFeedRegistry {
  return {
    optimism: {},
    arbitrum: {},
    base: {
      [token]: {
        feed,
        priceDecimals: 8,
      },
    },
  };
}

describe("PriceOracleCache", () => {
  it("returns cached price within ttl without repeated rpc", async () => {
    const readContract = vi
      .fn()
      .mockResolvedValueOnce([1n, 200_000_000n, 0n, BigInt(Math.floor(Date.now() / 1_000)), 1n]);
    const cache = new PriceOracleCache({
      chain,
      feedRegistry: registry(),
      publicClient: {
        readContract,
        multicall: vi.fn(),
      } as never,
      cacheTtlMs: 5_000,
    });

    const first = await cache.getUsdPrice(token);
    const second = await cache.getUsdPrice(token);

    expect(first).toBe(200_000_000n);
    expect(second).toBe(200_000_000n);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it("batch fetches missing tokens via multicall", async () => {
    const another = "0x0000000000000000000000000000000000000002" as Address;
    const anotherFeed = "0x0000000000000000000000000000000000000020" as Address;
    const feedRegistry: OracleFeedRegistry = {
      optimism: {},
      arbitrum: {},
      base: {
        [token]: { feed, priceDecimals: 8 },
        [another]: { feed: anotherFeed, priceDecimals: 8 },
      },
    };
    const multicall = vi.fn().mockResolvedValue([
      {
        status: "success",
        result: [1n, 100_000_000n, 0n, BigInt(Math.floor(Date.now() / 1_000)), 1n],
      },
      {
        status: "success",
        result: [1n, 300_000_000n, 0n, BigInt(Math.floor(Date.now() / 1_000)), 1n],
      },
    ]);
    const cache = new PriceOracleCache({
      chain,
      feedRegistry,
      publicClient: {
        readContract: vi.fn(),
        multicall,
      } as never,
    });

    const prices = await cache.batchGetUsdPrices([token, another]);

    expect(prices[token]).toBe(100_000_000n);
    expect(prices[another]).toBe(300_000_000n);
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("returns zero for stale oracle updates", async () => {
    const staleUpdatedAt = BigInt(Math.floor((Date.now() - 1_000_000) / 1_000));
    const cache = new PriceOracleCache({
      chain,
      feedRegistry: registry(),
      maxStaleMs: 1000,
      publicClient: {
        readContract: vi.fn().mockResolvedValue([1n, 200_000_000n, 0n, staleUpdatedAt, 1n]),
        multicall: vi.fn(),
      } as never,
    });

    const price = await cache.getUsdPrice(token);

    expect(price).toBe(0n);
  });
});
