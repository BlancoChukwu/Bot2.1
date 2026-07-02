#!/usr/bin/env node
/**
 * Start or restart the bot under PM2 with optional session log paths.
 * Usage: node scripts/pm2-bot-launch.mjs [--output <log>] [--error <err>]
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appName = "aave-liquidator-base";
const args = process.argv.slice(2);

function readFlag(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

const output = readFlag("--output");
const error = readFlag("--error");

function run(command) {
  execSync(command, { cwd: repoRoot, stdio: "inherit" });
}

function pm2Describe() {
  try {
    execSync(`pm2 describe ${appName}`, { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(join(repoRoot, "dist", "src", "index.js"))) {
  console.error("dist/src/index.js missing — run npm run build first");
  process.exit(1);
}

try {
  if (pm2Describe()) {
    run(`pm2 delete ${appName}`);
  }
} catch {
  // ignore stale pm2 state
}

const logFlags = [
  output ? `--output ${JSON.stringify(output)}` : "",
  error ? `--error ${JSON.stringify(error)}` : "",
].filter(Boolean).join(" ");

run(`pm2 start ecosystem.config.cjs ${logFlags} --update-env`.trim());
