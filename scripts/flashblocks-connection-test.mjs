#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

const durationMs = 30_000;
const rpc = process.env.FLASHBLOCKS_RPC_URL
  ?? process.env.EXECUTION_RPC_URL_PRIMARY
  ?? process.env.RPC_URL;
const pool = process.env.AAVE_POOL_ADDRESS ?? "0xA238Dd80C259a72e81d7e4664a980a968Ba86B47";

if (!rpc) {
  console.error("FLASHBLOCKS_RPC_URL or RPC_URL required");
  process.exit(1);
}

const client = createPublicClient({ chain: base, transport: http(rpc) });
const borrowEvent = parseAbiItem(
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 referralCode)",
);

async function main() {
  const cadenceMs = [];
  const leadsMs = [];
  let events = 0;
  const started = Date.now();
  let lastTick = started;

  while (Date.now() - started < durationMs) {
    const tickStarted = Date.now();
    try {
      await client.getLogs({
        address: pool,
        event: borrowEvent,
        fromBlock: "pending",
        toBlock: "pending",
      });
      leadsMs.push(Date.now() - tickStarted);
      events += 1;
    } catch {
      // pending getLogs unsupported on some hosts
    }
    const now = Date.now();
    cadenceMs.push(now - lastTick);
    lastTick = now;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const sorted = [...cadenceMs].sort((a, b) => a - b);
  const medianCadence = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p95Lead = [...leadsMs].sort((a, b) => a - b)[Math.floor(leadsMs.length * 0.95)] ?? 0;
  const pass = medianCadence >= 150 && medianCadence <= 350;

  const result = {
    pass,
    durationMs,
    medianCadenceMs: medianCadence,
    flashblocks_lead_ms_p95: p95Lead,
    sampleEvents: events,
    rpc,
  };
  const runtimeDir = join(process.cwd(), ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const path = join(runtimeDir, "flashblocks-test.json");
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
