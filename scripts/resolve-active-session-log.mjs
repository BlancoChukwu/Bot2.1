#!/usr/bin/env node
/**
 * Resolve the active bot session log for watch-bot / audits.
 * Prefers logs/latest-session.txt unconditionally — never let a large old soak
 * log outrank a fresh (possibly still-small) production session.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot =
  process.env.REPO_ROOT?.trim() ||
  join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MIN_BYTES = 2_048;

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readSessionMeta() {
  const metaPath = join(repoRoot, "logs", "latest-session.txt");
  if (!existsSync(metaPath)) {
    return undefined;
  }
  const meta = readFileSync(metaPath, "utf8");
  const logMatch = meta.match(/^log=(.+)$/m);
  if (logMatch === null) {
    return undefined;
  }
  const path = resolve(repoRoot, logMatch[1].trim());
  const prefix = meta.match(/^prefix=(.+)$/m)?.[1]?.trim();
  const started = meta.match(/^started=(.+)$/m)?.[1]?.trim();
  return {
    path: existsSync(path) ? path : undefined,
    prefix,
    started,
  };
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
    if (name.endsWith(".err.log") || name.includes(".err-")) {
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

function resolveGrowingSessionLog(session) {
  if (session.path === undefined) {
    return undefined;
  }
  if (fileSize(session.path) >= MIN_BYTES) {
    return session.path;
  }

  const pm2Log = pm2OutLog();
  if (pm2Log !== undefined && pm2Log !== session.path && fileSize(pm2Log) >= MIN_BYTES) {
    return pm2Log;
  }

  const sibling = `${session.path.replace(/\.log$/i, "")}-0.log`;
  if (existsSync(sibling) && fileSize(sibling) > fileSize(session.path)) {
    return sibling;
  }

  // PM2 sometimes writes prefix-YYYYMMDD-0.log instead of prefix-YYYYMMDD-HHMMSS-0.log
  const day = session.started?.slice(0, 8);
  if (session.prefix && day) {
    const dayLog = largestMatchingLog(`${session.prefix}-${day}`);
    if (dayLog !== undefined && fileSize(dayLog) > fileSize(session.path)) {
      return dayLog;
    }
  }

  return session.path;
}

// Prefer latest-session; if that path is a tiny PM2 stub, follow the real out log.
const session = readSessionMeta();
if (session !== undefined) {
  const resolved = resolveGrowingSessionLog(session);
  if (resolved !== undefined) {
    process.stdout.write(resolved);
    process.exit(0);
  }
}

const fallbacks = [
  pm2OutLog(),
  largestMatchingLog("event-purity-production-"),
  largestMatchingLog("event-purity-"),
  largestMatchingLog("event-purity-soak-"),
];

const seen = new Set();
const ranked = [];
for (const path of fallbacks) {
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
