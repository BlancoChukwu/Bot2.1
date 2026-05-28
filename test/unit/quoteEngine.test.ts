import { describe, expect, it, vi } from "vitest";
import { QuoteEngine } from "../../src/mirror/quoteEngine";
import { resetAmmMirror } from "../../src/mirror/ammMirror";

describe("QuoteEngine", () => {
  it("uses RPC fallback when mirror is cold", async () => {
    resetAmmMirror();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const engine = new QuoteEngine({
      logger,
      useLocalMirror: true,
      chainHead: async () => 100n,
    });
    const client = {
      readContract: vi.fn().mockResolvedValue([2_000n, 0n, 0, 0n]),
    };
    const out = await engine.quoteAmountOut(
      client,
      {
        name: "UniswapV3",
        router: "0x2626664c2603336E57B271c5C0b26F421741e481",
        feeBps: 5,
        quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        quoterPoolFee: 3_000,
      },
      "0x4200000000000000000000000000000000000006",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      1_000n,
    );
    expect(out).toBe(2_000n);
    expect(client.readContract).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "quote_engine_entry",
      expect.objectContaining({ mirrorStateSize: 0, forceRpcFallback: true }),
    );
  });

  it("getQuotesForPool returns RPC quotes when mirror empty", async () => {
    resetAmmMirror();
    const engine = new QuoteEngine({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      useLocalMirror: true,
    });
    const client = {
      readContract: vi.fn().mockResolvedValue([3_000n, 0n, 0, 0n]),
    };
    const quotes = await engine.getQuotesForPool(
      client,
      {
        name: "UniswapV3",
        router: "0x2626664c2603336E57B271c5C0b26F421741e481",
        feeBps: 5,
        quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        quoterPoolFee: 3_000,
      },
      "0x4200000000000000000000000000000000000006",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      [1_000n],
    );
    expect(quotes).toEqual([3_000n]);
  });
});
