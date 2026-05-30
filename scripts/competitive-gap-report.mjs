#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const hours = Number(process.argv.includes("--hours")
  ? process.argv[process.argv.indexOf("--hours") + 1]
  : process.env.COMPETITIVE_GAP_HOURS ?? "48");
const logsDir = join(process.cwd(), "logs");
const cutoffMs = Date.now() - hours * 60 * 60 * 1000;

function parseJsonLine(line) {
  const start = line.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  try {
    return JSON.parse(line.slice(start));
  } catch {
    return undefined;
  }
}

const files = readdirSync(logsDir)
  .filter((name) => name.endsWith(".log"))
  .map((name) => join(logsDir, name));

let detected = 0;
let won = 0;
let lostToCompetitor = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes("no_regret_outcome_recorded")) {
      continue;
    }
    const payload = parseJsonLine(line);
    if (!payload) {
      continue;
    }
    const ts = Date.parse(payload.time ?? "");
    if (Number.isFinite(ts) && ts < cutoffMs) {
      continue;
    }
    const outcome = payload.outcome;
    if (outcome !== "reverted") {
      detected += 1;
    }
    if (outcome === "won") {
      won += 1;
    }
    if (outcome === "lost_to_competitor") {
      lostToCompetitor += 1;
    }
  }
}

const sameBlockRatio = detected > 0 ? won / detected : 0;
const result = {
  hours,
  detected,
  won,
  lostToCompetitor,
  sameBlockRatio,
  targetMet: sameBlockRatio >= 0.7,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.targetMet ? 0 : 2);

