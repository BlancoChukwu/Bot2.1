import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { BASE_PROTOCOL_DATA_PROVIDER } from "../../src/config/oracleBootstrap";
import {
  PriceOracleCache,
  assertBaseFeedRegistry,
  canonicalBaseAaveOracleAddress,
  canonicalBaseCbBtcUsdFeed,
  canonicalBaseEthUsdFeed,
  canonicalBaseUsdcUsdFeed,
  validateAndNormalizeFeedAddress,
  type OracleFeedRegistry,
} from "../../src/utils/priceOracleCache";

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

  it("rejects denylisted non-chainlink feed at construction and falls back to aave", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const aaveOracle = canonicalBaseAaveOracleAddress;
    const readContract = vi.fn().mockResolvedValue(250_000_000_000_000_000_000n);
    const cache = new PriceOracleCache({
      chain,
      feedRegistry: {
        optimism: {},
        arbitrum: {},
        base: {
          [token]: {
            feed: BASE_PROTOCOL_DATA_PROVIDER,
            priceDecimals: 8,
          },
        },
      },
      aaveOracleAddress: aaveOracle,
      logger,
      publicClient: {
        readContract,
        multicall: vi.fn(),
      } as never,
    });

    const price = await cache.getUsdPrice(token);

    expect(price).toBe(250_000_000_000_000_000_000n);
    expect(logger.error).toHaveBeenCalledWith(
      "price_oracle_invalid_feed_address",
      expect.objectContaining({
        reason: "denylisted_non_chainlink_contract",
      }),
    );
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: aaveOracle,
        functionName: "getAssetPrice",
        args: [token],
      }),
    );
  });

  it("falls back to aave when fetchOne chainlink read throws", async () => {
    const aaveOracle = canonicalBaseAaveOracleAddress;
    const readContract = vi
      .fn()
      .mockRejectedValueOnce(new Error("InvalidAddressError"))
      .mockResolvedValueOnce(180_000_000n);
    const cache = new PriceOracleCache({
      chain,
      feedRegistry: registry(),
      aaveOracleAddress: aaveOracle,
      publicClient: {
        readContract,
        multicall: vi.fn(),
      } as never,
    });

    const price = await cache.getUsdPrice(token);

    expect(price).toBe(180_000_000n);
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it("validateAndNormalizeFeedAddress rejects malformed feed strings", () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const normalized = validateAndNormalizeFeedAddress(token, "not-an-address", {
      chain,
      logger,
    });
    expect(normalized).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "price_oracle_invalid_feed_address",
      expect.objectContaining({ reason: "not_an_address" }),
    );
  });

  it("assertBaseFeedRegistry validates all critical Base feeds", () => {
    const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
    const weth = "0x4200000000000000000000000000000000000006" as Address;
    const cbBtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;
    expect(() =>
      assertBaseFeedRegistry({
        optimism: {},
        arbitrum: {},
        base: {
          [weth]: { feed: canonicalBaseEthUsdFeed, priceDecimals: 8 },
          [usdc]: { feed: canonicalBaseUsdcUsdFeed, priceDecimals: 8 },
          [cbBtc]: { feed: canonicalBaseCbBtcUsdFeed, priceDecimals: 8 },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertBaseFeedRegistry({
        optimism: {},
        arbitrum: {},
        base: {
          [weth]: { feed: BASE_PROTOCOL_DATA_PROVIDER, priceDecimals: 8 },
          [usdc]: { feed: canonicalBaseUsdcUsdFeed, priceDecimals: 8 },
          [cbBtc]: { feed: canonicalBaseCbBtcUsdFeed, priceDecimals: 8 },
        },
      }),
    ).toThrow(/invalid/i);
  });
});
