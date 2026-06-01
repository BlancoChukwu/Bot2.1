#!/usr/bin/env node
/**
 * Build .env.simulation, .env.production, .env.production.budget from .env (or .env.production).
 * Usage: node scripts/bootstrap-env-profiles.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = [".env", ".env.production"]
  .map((name) => resolve(root, name))
  .find((path) => existsSync(path));

if (sourcePath === undefined) {
  console.error("bootstrap_env_profiles: no .env or .env.production found");
  process.exit(1);
}

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

let base = readFileSync(sourcePath, "utf8");
base = removeKey(base, "RPC_BUDGET_MODE");
base = removeKey(base, "BOT_ENV_PROFILE");

let production = upsert(base, "BOT_ENV_PROFILE", "production");
production = upsert(production, "SIMULATION_MODE", "false");
production = upsert(production, "RPC_BUDGET_MODE", "false");
writeFileSync(resolve(root, ".env.production"), production, "utf8");

let productionBudget = upsert(production, "BOT_ENV_PROFILE", "production-budget");
productionBudget = upsert(productionBudget, "RPC_BUDGET_MODE", "true");
writeFileSync(resolve(root, ".env.production.budget"), productionBudget, "utf8");

let simulation = upsert(production, "BOT_ENV_PROFILE", "simulation");
simulation = upsert(simulation, "SIMULATION_MODE", "true");
simulation = upsert(simulation, "RPC_BUDGET_MODE", "true");
simulation = upsert(simulation, "ENABLE_HEAP_SNAPSHOTS", "true");
simulation = upsert(simulation, "MEMORY_LOG_EVERY_CYCLES", "300");
simulation = upsert(simulation, "GATE_SCALE_FACTOR", "2");
simulation = upsert(simulation, "COMPETITIVE_GAP_MIN_RATIO", "0.35");
for (const key of [
  "POLL_INTERVAL_MS",
  "MULTICALL_BATCH_SIZE",
  "LOW_TIER_EVERY_BLOCKS",
  "FULL_WATCHLIST_SWEEP_INTERVAL_MS",
  "FLASHBLOCKS_PRIMARY_LOOP_MS",
]) {
  simulation = removeKey(simulation, key);
}
writeFileSync(resolve(root, ".env.simulation"), simulation, "utf8");

console.log(JSON.stringify({
  msg: "bootstrap_env_profiles_complete",
  source: sourcePath,
  wrote: [".env.production", ".env.production.budget", ".env.simulation"],
}, null, 2));
