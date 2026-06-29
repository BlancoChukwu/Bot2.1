#!/usr/bin/env node
/**
 * Gate: unconfirmed urgent/watch/liquidatable positions from runtime snapshot log.
 * Usage: node scripts/audit-unconfirmed-tier-positions.mjs <logPath>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const logPath = resolve(process.argv[2] ?? "");
const CONFIRM_MAX_STALENESS_BLOCKS = Number(process.env.CONFIRM_MAX_STALENESS_BLOCKS ?? "100");

let unconfirmed = 0;
for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const row = JSON.parse(line);
    if (row.msg !== "tier_unconfirmed_snapshot") continue;
    if (["urgent", "watch", "liquidatable"].includes(row.tier)) {
      const staleBlocks = row.staleBlocks ?? 0;
      if (staleBlocks > CONFIRM_MAX_STALENESS_BLOCKS) {
        unconfirmed += 1;
      }
    }
  } catch {
    // skip
  }
}

const pass = unconfirmed === 0;
console.log(JSON.stringify({
  event: pass ? "audit_unconfirmed_tier_ok" : "audit_unconfirmed_tier_fail",
  unconfirmed_urgent_watch_count: unconfirmed,
  confirmMaxStalenessBlocks: CONFIRM_MAX_STALENESS_BLOCKS,
}));
process.exit(pass ? 0 : 1);
