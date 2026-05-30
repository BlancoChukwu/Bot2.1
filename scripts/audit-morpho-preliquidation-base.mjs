#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

dotenv.config();

const MORPHO_MARKET_ABI = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);

const PRELIQ_FACTORY_ABI_VARIANTS = [
  parseAbi(["function preLiquidationEnabled(bytes32 marketId) view returns (bool)"]),
  parseAbi(["function isPreLiquidationEnabled(bytes32 marketId) view returns (bool)"]),
  parseAbi(["function preLiquidationConfigs(bytes32 marketId) view returns (bool enabled, uint256 preLltv, uint256 lltv)"]),
];

const rpc = process.env.RPC_URL ?? process.env.EXECUTION_RPC_URL_PRIMARY;
const morphoBlue = process.env.MORPHO_BLUE_ADDRESS;
const preLiqFactory = process.env.MORPHO_PRELIQ_FACTORY_ADDRESS;
const configuredMarketIds = (process.env.MORPHO_MARKET_IDS ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter((part) => /^0x[a-fA-F0-9]{64}$/.test(part));

if (!rpc || !morphoBlue || !preLiqFactory) {
  console.error("RPC_URL/EXECUTION_RPC_URL_PRIMARY, MORPHO_BLUE_ADDRESS, and MORPHO_PRELIQ_FACTORY_ADDRESS are required");
  process.exit(1);
}

const client = createPublicClient({ chain: base, transport: http(rpc) });

async function readPreLiqState(marketId) {
  for (const abi of PRELIQ_FACTORY_ABI_VARIANTS) {
    try {
      if (abi[0].name === "preLiquidationConfigs") {
        const config = await client.readContract({
          address: preLiqFactory,
          abi,
          functionName: "preLiquidationConfigs",
          args: [marketId],
        });
        return {
          enabled: Boolean(config?.[0]),
          preLLTV: config?.[1]?.toString?.() ?? null,
          lltv: config?.[2]?.toString?.() ?? null,
          source: "preLiquidationConfigs",
        };
      }
      const fn = abi[0].name;
      const enabled = await client.readContract({
        address: preLiqFactory,
        abi,
        functionName: fn,
        args: [marketId],
      });
      return {
        enabled: Boolean(enabled),
        preLLTV: null,
        lltv: null,
        source: fn,
      };
    } catch {
      // try next variant
    }
  }
  return {
    enabled: false,
    preLLTV: null,
    lltv: null,
    source: "unavailable",
  };
}

async function main() {
  if (configuredMarketIds.length === 0) {
    throw new Error("MORPHO_MARKET_IDS must include at least one bytes32 market id");
  }

  const markets = [];
  for (const marketId of configuredMarketIds) {
    const state = await readPreLiqState(marketId);
    const market = await client.readContract({
      address: morphoBlue,
      abi: MORPHO_MARKET_ABI,
      functionName: "market",
      args: [marketId],
    });
    const totalSupplyAssets = BigInt(market[0]);
    const totalBorrowAssets = BigInt(market[2]);
    const tvlProxy = totalSupplyAssets + totalBorrowAssets;
    markets.push({
      marketId,
      preLiquidationEnabled: state.enabled,
      preLLTV: state.preLLTV,
      lltv: state.lltv,
      tvlProxy: tvlProxy.toString(),
      readSource: state.source,
    });
  }

  const enabled = markets.filter((entry) => entry.preLiquidationEnabled);
  const topPreLiquidationMarketsByTvl = [...enabled]
    .sort((a, b) => (BigInt(a.tvlProxy) > BigInt(b.tvlProxy) ? -1 : 1))
    .slice(0, 10);

  const report = {
    chain: "base",
    fetchedAt: new Date().toISOString(),
    morphoBlueAddress: morphoBlue,
    factoryAddress: preLiqFactory,
    marketsWithPreLiquidationEnabled: enabled,
    topPreLiquidationMarketsByTvl,
    marketCount: markets.length,
  };

  const logsDir = join(process.cwd(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(logsDir, `audit-morpho-preliquidation-${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, enabledMarkets: enabled.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

