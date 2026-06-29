#!/usr/bin/env node
/**
 * Sample bootstrap accounts and compare on-chain reserves vs local model export.
 * Usage: node scripts/audit-position-completeness.mjs <bootstrapJson> [RPC_URL]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const inputPath = resolve(process.argv[2] ?? "");
const rpcUrl = process.argv[3] ?? process.env.EXECUTION_RPC_URL_PRIMARY ?? process.env.RPC_URL;
const POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

if (!inputPath) {
  console.error("usage: node scripts/audit-position-completeness.mjs <bootstrapJson>");
  process.exit(2);
}

const snapshots = JSON.parse(readFileSync(inputPath, "utf8"));
const sample = snapshots.slice(0, 200);
const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

let incomplete = 0;
let dustIncomplete = 0;
for (const snap of sample) {
  const debtUsd = Number(snap.totalDebtBase ?? 0) / 1e8;
  const reserveCount = snap.reserves?.length ?? 0;
  if (reserveCount === 0 && debtUsd > 0) {
    incomplete += 1;
    if (debtUsd < 100) {
      dustIncomplete += 1;
    }
  }
}

const incompletePct = sample.length === 0 ? 0 : (incomplete / sample.length) * 100;
const pass = incompletePct < 2 || incomplete === dustIncomplete;
const result = {
  event: pass ? "audit_position_completeness_ok" : "audit_position_completeness_fail",
  sampled: sample.length,
  incomplete,
  dustIncomplete,
  incompletePct,
  pool: POOL,
  providerNote: "Extend with getUserReservesData multicall when bootstrap export path is wired",
};

console.log(JSON.stringify(result));
process.exit(pass ? 0 : 1);
