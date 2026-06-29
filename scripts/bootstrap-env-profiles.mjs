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

function applyEventPurityStack(content) {
  let next = content;
  const keys = {
    USE_EVENT_WATCHLIST: "true",
    USE_PIPELINE_ORCHESTRATOR: "true",
    FLASHBLOCKS_ENABLED: "true",
    FLASHBLOCKS_PRIMARY_LOOP: "false",
    ENABLE_ARBITRAGE: "false",
    ENABLE_WATCH_TIER_CONFIRM: "false",
    BOOTSTRAP_ENABLED: "true",
    BOOTSTRAP_CACHE_ENABLED: "true",
    BOOTSTRAP_LOOKBACK_DAYS: "14",
    SKIP_COLD_START_FULL_SWEEP: "true",
    HYBRID_DETECTION_ENABLED: "false",
    FULL_WATCHLIST_SWEEP_INTERVAL_MS: "0",
  };
  for (const [key, value] of Object.entries(keys)) {
    next = upsert(next, key, value);
  }
  for (const key of [
    "POLL_INTERVAL_MS",
    "MULTICALL_BATCH_SIZE",
    "LOW_TIER_EVERY_BLOCKS",
    "FLASHBLOCKS_PRIMARY_LOOP_MS",
  ]) {
    next = removeKey(next, key);
  }
  return next;
}

let eventPuritySoak = applyEventPurityStack(simulation);
eventPuritySoak = upsert(eventPuritySoak, "BOT_ENV_PROFILE", "event-purity-soak");
eventPuritySoak = upsert(eventPuritySoak, "SIMULATION_MODE", "true");
eventPuritySoak = upsert(eventPuritySoak, "RPC_BUDGET_MODE", "true");
eventPuritySoak = upsert(eventPuritySoak, "ENABLE_LIVE_TX", "false");
eventPuritySoak = upsert(eventPuritySoak, "SKIP_DEPLOYMENT_SAFETY_GATE", "true");
eventPuritySoak = upsert(eventPuritySoak, "ENABLE_HEAP_SNAPSHOTS", "true");
eventPuritySoak = upsert(eventPuritySoak, "SHADOW_MAX_SAMPLES_PER_DAY", "10000");
eventPuritySoak = upsert(eventPuritySoak, "RSS_WARN_MB", "400");
writeFileSync(resolve(root, ".env.event-purity-soak"), eventPuritySoak, "utf8");

let eventPurityProduction = applyEventPurityStack(production);
eventPurityProduction = upsert(eventPurityProduction, "BOT_ENV_PROFILE", "event-purity-production");
eventPurityProduction = upsert(eventPurityProduction, "SIMULATION_MODE", "false");
eventPurityProduction = upsert(eventPurityProduction, "RPC_BUDGET_MODE", "false");
eventPurityProduction = upsert(eventPurityProduction, "ENABLE_LIVE_TX", "true");
eventPurityProduction = upsert(eventPurityProduction, "SKIP_DEPLOYMENT_SAFETY_GATE", "false");
writeFileSync(resolve(root, ".env.event-purity-production"), eventPurityProduction, "utf8");

console.log(JSON.stringify({
  msg: "bootstrap_env_profiles_complete",
  source: sourcePath,
  wrote: [
    ".env.production",
    ".env.production.budget",
    ".env.simulation",
    ".env.event-purity-soak",
    ".env.event-purity-production",
  ],
}, null, 2));
