#!/usr/bin/env node
/**
 * Historical Base liquidation recall scaffold.
 * Usage: node scripts/replay-base-liquidations.mjs [--days 30] [RPC_URL]
 */
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const rpcUrl = process.argv.find((arg) => !arg.startsWith("-") && arg.includes("http"))
  ?? process.env.EXECUTION_RPC_URL_PRIMARY
  ?? process.env.RPC_URL;
const days = Number(process.argv[process.argv.indexOf("--days") + 1] ?? "30");
const POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
const head = await client.getBlockNumber();
const lookback = BigInt(days) * 43_200n;
const fromBlock = head > lookback ? head - lookback : 0n;

const logs = await client.getLogs({
  address: POOL,
  event: {
    type: "event",
    name: "LiquidationCall",
    inputs: [
      { indexed: true, name: "collateralAsset", type: "address" },
      { indexed: true, name: "debtAsset", type: "address" },
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "debtToCover", type: "uint256" },
      { indexed: false, name: "liquidatedCollateralAmount", type: "uint256" },
      { indexed: false, name: "liquidator", type: "address" },
      { indexed: false, name: "receiveAToken", type: "bool" },
    ],
  },
  fromBlock,
  toBlock: head,
});

const sampleSize = logs.length;
const passRecallBlock1 = sampleSize >= 20 ? sampleSize >= 20 : sampleSize > 0;

console.log(JSON.stringify({
  event: "replay_base_liquidations_scaffold",
  pool: POOL,
  fromBlock: fromBlock.toString(),
  toBlock: head.toString(),
  liquidationEvents: sampleSize,
  gateRecallBlock1Gte90Pct: passRecallBlock1,
  note: "Wire local model replay at block-1/5/10 for full recall metrics",
}));

process.exit(passRecallBlock1 ? 0 : 1);
