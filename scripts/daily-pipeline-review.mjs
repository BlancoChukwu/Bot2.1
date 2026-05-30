#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const logsDir = join(process.cwd(), "logs");
const minCycles = Number(process.env.DAILY_REVIEW_MIN_CYCLES ?? "12");
const mirrorRequired = (process.env.USE_LOCAL_MIRROR ?? "false").toLowerCase() === "true";
const maxUnhandledReverts = Number(process.env.DAILY_REVIEW_MAX_UNHANDLED_REVERTS ?? "0");

function latestLogFile() {
  const files = readdirSync(logsDir)
    .filter((name) => name.startsWith("production-") && name.endsWith(".log"))
    .sort();
  return files.at(-1);
}

function parseCycles(text) {
  const lines = text.split("\n").filter((line) => line.includes("pipeline_cycle_complete"));
  let sentZeroStreak = 0;
  let maxStreak = 0;
  for (const line of lines.slice(-minCycles)) {
    const sentMatch = line.match(/"sent":(\d+)/);
    const sent = sentMatch ? Number(sentMatch[1]) : 0;
    if (sent === 0) {
      sentZeroStreak += 1;
      maxStreak = Math.max(maxStreak, sentZeroStreak);
    } else {
      sentZeroStreak = 0;
    }
  }
  return { cycles: lines.length, maxSentZeroStreak: maxStreak };
}

function parseExecutionQuality(text) {
  const lines = text.split("\n");
  const simulated = lines.filter((line) => line.includes("pipeline_execution_simulated")).length;
  const sent = lines.filter((line) => line.includes("\"sent\":")).length;
  const unhandledReverts = lines.filter((line) => line.includes("receipt_reverted")).length;
  return { simulated, sent, unhandledReverts };
}

const latest = latestLogFile();
if (!latest) {
  console.log("daily_pipeline_review: no production log found");
  process.exit(0);
}

const text = readFileSync(join(logsDir, latest), "utf8");
const { cycles, maxSentZeroStreak } = parseCycles(text);
const quality = parseExecutionQuality(text);
const alert = mirrorRequired && maxSentZeroStreak >= minCycles;
const qualityAlert = quality.unhandledReverts > maxUnhandledReverts;
console.log(JSON.stringify({
  log: latest,
  cyclesParsed: cycles,
  maxSentZeroStreak,
  simulatedExecutions: quality.simulated,
  sentExecutions: quality.sent,
  unhandledReverts: quality.unhandledReverts,
  mirrorRequired,
  alert,
  qualityAlert,
  escapeHatch: alert ? "Set ESCAPE_HATCH_SINGLE_PAIR=WETH/USDC and restart" : null,
}, null, 2));
process.exit(alert || qualityAlert ? 2 : 0);
