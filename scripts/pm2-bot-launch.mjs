#!/usr/bin/env node
/**
 * Start or restart the bot under PM2 with optional session log paths.
 * Usage: node scripts/pm2-bot-launch.mjs [--output <log>] [--error <err>]
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
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

function logLaunchEvent(msg, extra = {}) {
  if (!output) return;
  appendFileSync(
    output,
    `${JSON.stringify({
      level: 30,
      time: new Date().toISOString(),
      msg,
      ...extra,
    })}\n`,
    "utf8",
  );
}

function resolvePm2Bin() {
  const pathPrefixes = [
    process.env.PATH ?? "",
    "/usr/local/bin",
    "/usr/bin",
    `${process.env.HOME ?? ""}/.local/bin`,
    `${process.env.HOME ?? ""}/.npm-global/bin`,
  ].join(":");
  const env = { ...process.env, PATH: pathPrefixes };
  try {
    return execSync("command -v pm2", { encoding: "utf8", env, cwd: repoRoot }).trim();
  } catch {
    return undefined;
  }
}

function runPm2(pm2Bin, command) {
  execSync(`${pm2Bin} ${command}`, { cwd: repoRoot, stdio: "inherit", env: process.env });
}

function pm2Describe(pm2Bin) {
  try {
    execSync(`${pm2Bin} describe ${appName}`, { cwd: repoRoot, stdio: "ignore", env: process.env });
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(join(repoRoot, "dist", "src", "index.js"))) {
  console.error("dist/src/index.js missing — run npm run build first");
  process.exit(1);
}

const pm2Bin = resolvePm2Bin();
if (pm2Bin === undefined) {
  logLaunchEvent("pm2_launch_failed", { error: "pm2 binary not found in PATH" });
  console.error("pm2 not found — install with: npm i -g pm2");
  process.exit(1);
}

try {
  if (pm2Describe(pm2Bin)) {
    runPm2(pm2Bin, `delete ${appName}`);
  }

  const logFlags = [
    output ? `--output ${JSON.stringify(output)}` : "",
    error ? `--error ${JSON.stringify(error)}` : "",
  ].filter(Boolean).join(" ");

  runPm2(pm2Bin, `start ecosystem.config.cjs ${logFlags} --update-env`.trim());

  if (!pm2Describe(pm2Bin)) {
    throw new Error("pm2 describe failed after start");
  }

  logLaunchEvent("pm2_supervisor_started", {
    app: appName,
    pm2Bin,
    dotenv: process.env.DOTENV_CONFIG_PATH,
    simulationMode: process.env.SIMULATION_MODE,
  });
} catch (launchError) {
  logLaunchEvent("pm2_launch_failed", {
    error: launchError instanceof Error ? launchError.message : String(launchError),
    pm2Bin,
  });
  console.error("pm2 launch failed:", launchError);
  process.exit(1);
}
