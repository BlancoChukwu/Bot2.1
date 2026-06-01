#!/usr/bin/env node
/**
 * Start portable Redis from .runtime/redis when REDIS_URL points at localhost and nothing is listening.
 * Usage: node scripts/ensure-redis.mjs
 */
import { config } from "dotenv";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";

import { resolveDotenvPath } from "./env-profile-path.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolveDotenvPath(root) });

const redisUrl = process.env.REDIS_URL?.trim();
if (redisUrl === undefined || redisUrl === "") {
  console.log("ensure_redis_skipped", { reason: "REDIS_URL unset" });
  process.exit(0);
}

function parseLocalRedis(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return undefined;
  }
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    return undefined;
  }
  const port = parsed.port === "" ? 6379 : Number(parsed.port);
  if (!Number.isFinite(port) || port <= 0) {
    return undefined;
  }
  return { host, port, url: urlString };
}

const target = parseLocalRedis(redisUrl);
if (target === undefined) {
  console.log("ensure_redis_skipped", { reason: "non_local_redis_url" });
  process.exit(0);
}

async function pingRedis() {
  const client = new Redis(target.url, {
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    return pong === "PONG";
  } catch {
    try {
      client.disconnect();
    } catch {
      // ignore
    }
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function bundledRedisServer() {
  const exe = process.platform === "win32" ? "redis-server.exe" : "redis-server";
  const dir = join(root, ".runtime", "redis");
  const serverPath = join(dir, exe);
  if (!existsSync(serverPath)) {
    return undefined;
  }
  const conf = join(dir, process.platform === "win32" ? "redis.windows.conf" : "redis.conf");
  return { serverPath, conf, cwd: dir };
}

function startBundledRedis(bundle) {
  const args = existsSync(bundle.conf) ? [bundle.conf] : [];
  const child = spawn(bundle.serverPath, args, {
    cwd: bundle.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  console.log("ensure_redis_started", { pid: child.pid, config: bundle.conf });
}

const alive = await pingRedis();
if (alive) {
  console.log("ensure_redis_ok", { url: redisUrl, status: "already_running" });
  process.exit(0);
}

const bundle = bundledRedisServer();
if (bundle === undefined) {
  console.error("ensure_redis_failed", {
    reason: "redis_not_running_and_no_bundled_server",
    hint: "Install Redis or place redis-server under .runtime/redis/",
  });
  process.exit(1);
}

startBundledRedis(bundle);

for (let attempt = 0; attempt < 20; attempt += 1) {
  await sleep(500);
  if (await pingRedis()) {
    console.log("ensure_redis_ok", { url: redisUrl, status: "started", attempts: attempt + 1 });
    process.exit(0);
  }
}

console.error("ensure_redis_failed", { reason: "timeout_waiting_for_ping", url: redisUrl });
process.exit(1);
