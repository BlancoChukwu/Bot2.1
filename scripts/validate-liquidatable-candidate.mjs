#!/usr/bin/env node
/**
 * Validate event_purity_liquidatable_candidate rows against on-chain HF.
 * Usage: node scripts/validate-liquidatable-candidate.mjs <logPath> [RPC_URL]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const logPath = resolve(process.argv[2] ?? "");
const rpcUrl = process.argv[3]
  ?? process.env.EXECUTION_RPC_URL_PRIMARY
  ?? process.env.RPC_URL;
const POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

const abi = [{
  name: "getUserAccountData",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "user", type: "address" }],
  outputs: [
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ],
}];

const candidates = [];
for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const row = JSON.parse(line);
    if (row.msg === "event_purity_liquidatable_candidate" && row.account) {
      candidates.push(row);
    }
  } catch {
    // skip
  }
}

if (candidates.length === 0) {
  console.log(JSON.stringify({ event: "validate_candidates_ok", checked: 0 }));
  process.exit(0);
}

const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
const failures = [];
for (const row of candidates.slice(-20)) {
  const data = await client.readContract({
    address: POOL,
    abi,
    functionName: "getUserAccountData",
    args: [row.account],
  });
  const hf = Number(data[5]) / 1e18;
  const localHf = row.healthFactor;
  if (hf >= 1) {
    failures.push({ account: row.account, onChainHf: hf, localHf, reason: "not_liquidatable_on_chain" });
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ event: "validate_candidates_failed", failures }));
  process.exit(1);
}

console.log(JSON.stringify({ event: "validate_candidates_ok", checked: Math.min(candidates.length, 20) }));
