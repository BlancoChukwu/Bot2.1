import "dotenv/config";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import {
  computeUniswapV3PoolTvlUsd,
  type PoolTvlToken,
} from "../src/oracle/uniswapV3PoolTvl";
import { maxCollateralSwapUsdForTvl } from "../src/config/uniswapV3LiquidationRoutes";

const FEE_TIERS = [100, 500, 3_000, 10_000] as const;

const TOKENS = {
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  USDC: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
  cbBTC: { address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8 },
  cbETH: { address: "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", decimals: 18 },
  wstETH: { address: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", decimals: 18 },
  weETH: { address: "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a", decimals: 18 },
  AAVE: { address: "0x63706e401c06ac8513145b7687a14804d17f814b", decimals: 18 },
  GHO: { address: "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee", decimals: 18 },
  EURC: { address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", decimals: 6 },
  USDbC: { address: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", decimals: 6 },
} as const satisfies Record<string, PoolTvlToken>;

const PAIRS = [
  ["WETH", "USDC"],
  ["cbBTC", "USDC"],
  ["cbBTC", "WETH"],
  ["cbETH", "USDC"],
  ["cbETH", "WETH"],
  ["wstETH", "USDC"],
  ["wstETH", "WETH"],
  ["weETH", "WETH"],
  ["AAVE", "USDC"],
  ["AAVE", "WETH"],
  ["GHO", "USDC"],
  ["EURC", "USDC"],
  ["USDbC", "USDC"],
] as const satisfies ReadonlyArray<readonly [keyof typeof TOKENS, keyof typeof TOKENS]>;

const rpcUrl = process.env.BASE_RPC_URL?.trim() || process.env.RPC_URL?.trim();
if (rpcUrl === undefined) {
  throw new Error("BASE_RPC_URL or RPC_URL is required");
}

const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

async function main(): Promise<void> {
  const blockNumber = await client.getBlockNumber();
  console.log(JSON.stringify({
    validAsOfBlock: blockNumber.toString(),
    validAsOfIso: new Date().toISOString(),
    source: "Uniswap V3 pool balances valued with live Base Aave oracle prices",
  }));

  for (const [collateralSymbol, debtSymbol] of PAIRS) {
    const collateral = TOKENS[collateralSymbol];
    const debt = TOKENS[debtSymbol];
    const rankings: Array<{ fee: number; pool: Address; tvlUsd: number }> = [];
    for (const fee of FEE_TIERS) {
      const { tvlUsd, pool } = await computeUniswapV3PoolTvlUsd(client, {
        tokenA: collateral,
        tokenB: debt,
        fee,
        blockNumber,
      });
      rankings.push({ fee, pool, tvlUsd });
    }
    rankings.sort((left, right) => right.tvlUsd - left.tvlUsd);
    const snapshotTvlUsd = rankings[0]?.tvlUsd ?? 0;
    console.log(JSON.stringify({
      pair: `${collateralSymbol}->${debtSymbol}`,
      rankings,
      recommendedFee: rankings[0]?.fee,
      snapshotTvlUsd,
      maxCollateralSwapUsd: maxCollateralSwapUsdForTvl(snapshotTvlUsd),
    }));
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
