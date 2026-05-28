#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

const poolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const rpc = process.env.RPC_URL ?? process.env.EXECUTION_RPC_URL_PRIMARY;
const pool = process.env.AAVE_POOL_ADDRESS ?? "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
function loadNearLiqFromLatestAudit() {
  const outDir = join(process.cwd(), "logs");
  let files = [];
  try {
    files = readdirSync(outDir)
      .filter((name) => name.startsWith("audit-watchlist-") && name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const latest = files[files.length - 1];
  if (latest === undefined) {
    return [];
  }
  try {
    const payload = JSON.parse(readFileSync(join(outDir, latest), "utf8"));
    return (payload.rows ?? [])
      .filter((row) => row.bucket === "near_liquidation_hf_lt_1_05")
      .map((row) => String(row.account));
  } catch {
    return [];
  }
}

let addresses = (process.env.AUDIT_WATCHLIST_ADDRESSES ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean);
if (addresses.length === 0) {
  addresses = loadNearLiqFromLatestAudit();
}

if (!rpc) {
  console.error("RPC_URL required");
  process.exit(1);
}

const client = createPublicClient({ chain: base, transport: http(rpc) });

async function main() {
  const rows = [];
  for (const account of addresses) {
    const data = await client.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "getUserAccountData",
      args: [account],
    });
    const hf = Number(data[5]) / 1e18;
    const debt = Number(data[1]) / 1e8;
    let bucket = "healthy_tier_skipped";
    if (hf < 1) {
      bucket = "liquidatable_now";
    } else if (hf < 1.05) {
      bucket = "near_liquidation_hf_lt_1_05";
    } else if (debt < 50) {
      bucket = "dust_below_min_debt";
    }
    rows.push({ account, healthFactor: hf, totalDebtBaseUsd: debt, bucket });
  }
  const outDir = join(process.cwd(), "logs");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(outDir, `audit-watchlist-${stamp}.json`);
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`Wrote ${path} (${rows.length} accounts)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
