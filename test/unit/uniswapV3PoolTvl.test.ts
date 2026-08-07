import { describe, expect, it } from "vitest";
import {
  computeUniswapV3PoolTvlUsd,
  type PoolTvlReadClient,
} from "../../src/oracle/uniswapV3PoolTvl";

const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const POOL = "0xa8E4C55D6dAf4D768aeBa2378c1AD94c112Ef48a" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

function stubClient(handlers: {
  getPool: string;
  balances?: Record<string, bigint>;
  prices?: Record<string, bigint>;
}): PoolTvlReadClient {
  return {
    async readContract(args: Record<string, unknown>): Promise<unknown> {
      const fn = args.functionName as string;
      if (fn === "getPool") {
        return handlers.getPool;
      }
      const target = (args.address as string).toLowerCase();
      if (fn === "balanceOf") {
        return handlers.balances?.[target] ?? 0n;
      }
      if (fn === "getAssetPrice") {
        const asset = (args.args as string[])[0]!.toLowerCase();
        return handlers.prices?.[asset] ?? 0n;
      }
      throw new Error(`unexpected call ${fn}`);
    },
  };
}

describe("computeUniswapV3PoolTvlUsd", () => {
  it("returns zero TVL for a non-existent pool", async () => {
    const client = stubClient({ getPool: ZERO });
    const result = await computeUniswapV3PoolTvlUsd(client, {
      tokenA: { address: CBETH, decimals: 18 },
      tokenB: { address: USDC, decimals: 6 },
      fee: 3_000,
    });
    expect(result).toEqual({ tvlUsd: 0, pool: ZERO });
  });

  it("values both legs with Aave oracle prices (8-decimal)", async () => {
    const client = stubClient({
      getPool: POOL,
      balances: {
        [CBETH.toLowerCase()]: 1_000_000_000_000_000_000n, // 1 cbETH
        [USDC.toLowerCase()]: 3_000_000_000n, // 3,000 USDC
      },
      prices: {
        [CBETH.toLowerCase()]: 300_000_000_000n, // $3,000.00 (8dp)
        [USDC.toLowerCase()]: 100_000_000n, // $1.00 (8dp)
      },
    });
    const result = await computeUniswapV3PoolTvlUsd(client, {
      tokenA: { address: CBETH, decimals: 18 },
      tokenB: { address: USDC, decimals: 6 },
      fee: 3_000,
    });
    expect(result.pool).toBe(POOL);
    expect(result.tvlUsd).toBeCloseTo(6_000, 6);
  });
});
