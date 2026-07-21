#!/usr/bin/env node
/**
 * Upsert receiver-v5 / fee-map keys into local env profiles without a full bootstrap rewrite.
 * Usage: node scripts/sync-env-receiver-v5.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  ".env",
  ".env.production",
  ".env.production.budget",
  ".env.simulation",
  ".env.event-purity-soak",
  ".env.event-purity-production",
];

function upsert(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return `${content.trimEnd()}\n${line}\n`;
}

function removeKey(content, key) {
  return content
    .split("\n")
    .filter((line) => !line.startsWith(`${key}=`))
    .join("\n");
}

function syncFile(relPath) {
  const path = resolve(root, relPath);
  if (!existsSync(path)) {
    return { path: relPath, status: "skipped_missing" };
  }
  let next = readFileSync(path, "utf8");
  const before = next;
  next = removeKey(next, "LIQUIDATION_SWAP_POOL_FEE");
  next = upsert(next, "LIQUIDATION_RECEIVER_EXPECTED_VERSION", "5");
  next = upsert(next, "LIQUIDATION_SWAP_SLIPPAGE_BPS", "200");
  if (next === before) {
    return { path: relPath, status: "unchanged" };
  }
  writeFileSync(path, next, "utf8");
  return { path: relPath, status: "updated" };
}

const results = TARGETS.map(syncFile);
console.log(JSON.stringify({ event: "sync_env_receiver_v5_complete", results }, null, 2));
