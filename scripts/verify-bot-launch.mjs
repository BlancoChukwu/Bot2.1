#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const logFile = resolve(process.argv[2] ?? "");
if (!logFile) {
  console.error("usage: node scripts/verify-bot-launch.mjs <log-file>");
  process.exit(1);
}

await sleep(4_000);

let text = "";
if (existsSync(logFile)) {
  text = readFileSync(logFile, "utf8");
}

if (text.includes("fatal_startup_error")) {
  console.error("STARTUP FAILED — fatal_startup_error in log:");
  console.error(text.trim().split(/\r?\n/).slice(-5).join("\n"));
  process.exit(1);
}

if (text.includes("deployment_safety_gate_blocked")) {
  console.error("SAFETY GATE BLOCKED — run Setup Dry Run Receipt.cmd, then Production within 15 minutes.");
  const line = text.split(/\r?\n/).find((l) => l.includes("deployment_safety_gate_blocked"));
  if (line) console.error(line);
  process.exit(1);
}

let status;
try {
  status = JSON.parse(
    execSync("node scripts/ensure-single-bot.mjs --status", { encoding: "utf8" }),
  );
} catch {
  status = { count: 0 };
}

if (status.count === 0 && text.length < 80) {
  console.error("Bot process not running and log is nearly empty:", logFile);
  process.exit(1);
}

if (status.count > 0) {
  console.log("Bot running (pid count:", status.count + "). Log:", logFile, "(" + text.length + " bytes)");
  process.exit(0);
}

if (text.includes("single_instance_lock_acquired") || text.includes("metrics_server_started")) {
  console.log("Startup log looks healthy:", logFile);
  process.exit(0);
}

console.warn("Bot status unclear — check log manually:", logFile);
process.exit(0);
