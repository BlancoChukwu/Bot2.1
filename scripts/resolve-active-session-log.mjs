#!/usr/bin/env node
/**
 * Resolve the active bot session log for watch-bot / audits.
 * Prefers PM2 out_log when the launcher stub is still tiny.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MIN_BYTES = 2_048;

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function sessionLogFromMeta() {
  const metaPath = join(repoRoot, "logs", "latest-session.txt");
  if (!existsSync(metaPath)) {
    return undefined;
  }
  const meta = readFileSync(metaPath, "utf8");
  const match = meta.match(/^log=(.+)$/m);
  if (match === null) {
    return undefined;
  }
  const path = resolve(repoRoot, match[1].trim());
  return existsSync(path) ? path : undefined;
}

function pm2OutLog() {
  try {
    const raw = execSync("pm2 jlist", { encoding: "utf8", cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
    const apps = JSON.parse(raw);
    const app = apps.find((row) => row.name === "aave-liquidator-base");
    const path = app?.pm2_env?.pm_out_log_path;
    return typeof path === "string" && existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function largestMatchingLog(prefix) {
  const logsDir = join(repoRoot, "logs");
  if (!existsSync(logsDir)) {
    return undefined;
  }
  let best;
  for (const name of readdirSync(logsDir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".log")) {
      continue;
    }
    const path = join(logsDir, name);
    const size = fileSize(path);
    if (best === undefined || size > best.size) {
      best = { path, size };
    }
  }
  return best?.path;
}

const candidates = [
  sessionLogFromMeta(),
  pm2OutLog(),
  largestMatchingLog("event-purity-soak-"),
  largestMatchingLog("event-purity-"),
];

const seen = new Set();
const ranked = [];
for (const path of candidates) {
  if (path === undefined || seen.has(path)) {
    continue;
  }
  seen.add(path);
  ranked.push({ path, size: fileSize(path) });
}

ranked.sort((left, right) => right.size - left.size);
const chosen = ranked.find((row) => row.size >= MIN_BYTES) ?? ranked[0];
if (chosen === undefined) {
  process.exit(1);
}
process.stdout.write(chosen.path);
