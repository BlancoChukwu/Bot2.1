#!/usr/bin/env node
/**
 * Validates event-purity soak / production env before launch.
 * Usage: node scripts/preflight-event-purity-env.mjs <path-to-env-file>
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.argv[2] ?? "");
if (!envPath || !existsSync(envPath)) {
  console.error(JSON.stringify({
    event: "preflight_event_purity_failed",
    reason: "env_file_missing",
    path: envPath || "(not set)",
  }));
  process.exit(1);
}

const env = parseEnvFile(readFileSync(envPath, "utf8"));
const errors = [];
const warnings = [];

function truthyValue(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

if (!truthyValue(env.USE_EVENT_WATCHLIST)) {
  errors.push("USE_EVENT_WATCHLIST must be true");
}
if (!truthyValue(env.USE_PIPELINE_ORCHESTRATOR)) {
  errors.push("USE_PIPELINE_ORCHESTRATOR must be true");
}
if (!truthyValue(env.FLASHBLOCKS_ENABLED)) {
  errors.push("FLASHBLOCKS_ENABLED must be true");
}
if (truthyValue(env.FLASHBLOCKS_ENABLED) && !hasValue(env.WS_RPC_URL_PRIMARY)) {
  errors.push("WS_RPC_URL_PRIMARY is required when FLASHBLOCKS_ENABLED=true");
}
if (!hasValue(env.EXECUTION_RPC_URL_PRIMARY) && !hasValue(env.RPC_URL)) {
  errors.push("Set EXECUTION_RPC_URL_PRIMARY or RPC_URL for bootstrap/execution");
}
if (truthyValue(env.ENABLE_ARBITRAGE)) {
  warnings.push("ENABLE_ARBITRAGE=true — event-purity launchers expect false");
}
if (truthyValue(env.FLASHBLOCKS_PRIMARY_LOOP)) {
  warnings.push("FLASHBLOCKS_PRIMARY_LOOP=true — event-purity stack uses native WS clock");
}

const executionHost = hostFromUrl(env.EXECUTION_RPC_URL_PRIMARY ?? env.RPC_URL);
if (executionHost.includes("alchemy.com")) {
  warnings.push("EXECUTION_RPC on Alchemy — prefer NodeReal for multicall/bootstrap if quota is tight");
}

for (const warning of warnings) {
  console.warn(JSON.stringify({ event: "preflight_event_purity_warn", warning }));
}

if (errors.length > 0) {
  console.error(JSON.stringify({
    event: "preflight_event_purity_failed",
    errors,
    envFile: envPath,
  }));
  process.exit(1);
}

console.log(JSON.stringify({
  event: "preflight_event_purity_ok",
  envFile: envPath,
  chain: env.CHAIN ?? "base",
  simulationMode: env.SIMULATION_MODE ?? "unknown",
  enableLiveTx: env.ENABLE_LIVE_TX ?? "false",
  bootstrapCache: env.BOOTSTRAP_CACHE_ENABLED ?? "true",
}));

function parseEnvFile(content) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim().replace(/\r$/, "");
    const value = trimmed.slice(eq + 1).replace(/\r$/, "");
    out[key] = value;
  }
  return out;
}

function hasValue(value) {
  return value !== undefined && value.trim().length > 0;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
