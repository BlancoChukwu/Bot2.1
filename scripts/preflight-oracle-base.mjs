#!/usr/bin/env node
/**
 * RPC + Aave oracle preflight for Base event-purity launch.
 * Usage: node scripts/preflight-oracle-base.mjs [RPC_URL]
 */
import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";

const RPC_URL = process.argv[2]
  ?? process.env.EXECUTION_RPC_URL_PRIMARY
  ?? process.env.RPC_URL;

const BASE_AAVE_ORACLE = "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const BASE_USDBC = "0xd9aaEC86B65d86f6A7B5B1b0c42FFA531710B6CA";
const BASE_GHO = "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee";
const BASE_EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
const BASE_WSTETH = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
const BASE_WEETH = "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A";
const BASE_AAVE = "0x63706e401c06ac8513145b7687a14804d17f814b";
const BASE_TBTC = "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b";
const BASE_SYRUP_USDC = "0x660975730059246a68521a3e2fbd4740173100f5";
const BASE_LBTC = "0xecac9c5f704e954931349da37f60e39f515c11c1";

const GAP_FILL_ASSETS = [
  ["USDC", BASE_USDC],
  ["cbETH", BASE_CBETH],
  ["USDbC", BASE_USDBC],
  ["GHO", BASE_GHO],
  ["EURC", BASE_EURC],
  ["wstETH", BASE_WSTETH],
  ["weETH", BASE_WEETH],
  ["AAVE", BASE_AAVE],
  ["tBTC", BASE_TBTC],
  ["syrupUSDC", BASE_SYRUP_USDC],
  ["LBTC", BASE_LBTC],
];

const oracleAbi = [
  {
    name: "getAssetPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

if (!RPC_URL) {
  console.error(JSON.stringify({
    event: "preflight_oracle_failed",
    reason: "rpc_url_missing",
  }));
  process.exit(1);
}

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

try {
  const [blockNumber, block] = await Promise.all([
    client.getBlockNumber(),
    client.getBlock({ blockTag: "latest" }),
  ]);

  const results = await client.multicall({
    contracts: GAP_FILL_ASSETS.map(([, asset]) => ({
      address: BASE_AAVE_ORACLE,
      abi: oracleAbi,
      functionName: "getAssetPrice",
      args: [asset],
    })),
    allowFailure: true,
  });

  const prices = {};
  const errors = [];
  for (let i = 0; i < GAP_FILL_ASSETS.length; i += 1) {
    const [symbol, asset] = GAP_FILL_ASSETS[i];
    const response = results[i];
    if (response?.status !== "success" || typeof response.result !== "bigint" || response.result <= 0n) {
      errors.push(`${symbol}: oracle price unavailable`);
      continue;
    }
    prices[symbol] = {
      asset,
      priceBase8: response.result.toString(),
      priceUsd: formatUnits(response.result, 8),
    };
  }

  const usdcPrice = results[0]?.status === "success" ? results[0].result : 0n;
  if (usdcPrice < 99_000_000n || usdcPrice > 101_000_000n) {
    errors.push(`USDC oracle price out of peg band: ${formatUnits(usdcPrice, 8)}`);
  }

  if (errors.length > 0) {
    console.error(JSON.stringify({
      event: "preflight_oracle_failed",
      rpc: maskRpc(RPC_URL),
      blockNumber: blockNumber.toString(),
      blockTimestamp: Number(block.timestamp),
      errors,
      prices,
    }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    event: "preflight_oracle_ok",
    rpc: maskRpc(RPC_URL),
    oracle: BASE_AAVE_ORACLE,
    blockNumber: blockNumber.toString(),
    blockTimestamp: Number(block.timestamp),
    prices,
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: "preflight_oracle_failed",
    rpc: maskRpc(RPC_URL),
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}

function maskRpc(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
}
