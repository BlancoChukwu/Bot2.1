#!/usr/bin/env node
/**
 * Live liquidation stream for watch-bot --liquidations.
 * Usage:
 *   node scripts/watch-bot-liquidations.mjs <logPath> [--all-evals] [--backlog 40] [--once]
 *   node scripts/watch-bot-liquidations.mjs --format-line [--all-evals] [--color]   # stdin lines
 */
import { closeSync, openSync, readSync, statSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { classifyEvent, formatEvent, formatLogLine } from "./watchBotLiquidationsFormat.mjs";

const args = process.argv.slice(2);
const allEvals = args.includes("--all-evals");
const once = args.includes("--once");
const formatLineMode = args.includes("--format-line");
const forceColor = args.includes("--color");
const noColor = args.includes("--no-color");
const backlogIdx = args.indexOf("--backlog");
const backlog = backlogIdx >= 0 ? Number(args[backlogIdx + 1] ?? 40) : 40;

const color = noColor ? false : forceColor ? true : Boolean(process.stdout.isTTY);

function printLegend() {
  const lines = [
    "Liquidation stream — evals / sends / fails (Ctrl+C to exit)",
    "  badges: SENT=tx submitted  TRY=attempt/candidate  LIQ=interesting eval  CYCLE=summary  FAIL/WARN=errors",
    allEvals
      ? "  mode: --all-evals (includes healthy HF skips)"
      : "  mode: actionable only (add --all-evals for every liquidation_evaluated)",
  ];
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write("\n");
}

function emitLine(raw) {
  const formatted = formatLogLine(raw, { allEvals, color });
  if (formatted != null) {
    process.stdout.write(`${formatted}\n`);
  }
}

async function runFormatLineMode() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    emitLine(line);
  }
}

function readNewBytes(path, offset) {
  const st = statSync(path);
  if (st.size < offset) {
    return { nextOffset: st.size, text: "" };
  }
  if (st.size === offset) {
    return { nextOffset: offset, text: "" };
  }
  const length = st.size - offset;
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  return { nextOffset: st.size, text: buf.toString("utf8") };
}

function scanBacklog(path, maxMatches) {
  const st = statSync(path);
  const maxBytes = Math.min(st.size, 2 * 1024 * 1024);
  const start = st.size - maxBytes;
  const buf = Buffer.alloc(maxBytes);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, maxBytes, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const matched = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const tier = classifyEvent(row, { allEvals });
    if (tier == null) continue;
    matched.push(formatEvent(row, tier, { color }));
  }
  return matched.slice(-Math.max(0, maxMatches));
}

function followLog(path) {
  printLegend();
  if (backlog > 0) {
    const prior = scanBacklog(path, backlog);
    if (prior.length > 0) {
      process.stdout.write(`── last ${prior.length} matching events ──\n`);
      for (const line of prior) process.stdout.write(`${line}\n`);
      process.stdout.write(`── live ──\n`);
    }
  }

  let offset = statSync(path).size;
  let pending = "";

  const flush = () => {
    const chunk = readNewBytes(path, offset);
    offset = chunk.nextOffset;
    if (!chunk.text) return;
    pending += chunk.text;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) emitLine(line);
  };

  flush();
  if (once) {
    process.exit(0);
  }

  watchFile(path, { interval: 500 }, () => {
    try {
      flush();
    } catch (err) {
      process.stderr.write(`watch_error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  });
}

if (formatLineMode) {
  await runFormatLineMode();
  process.exit(0);
}

const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--backlog") {
    i += 1;
    continue;
  }
  if (args[i].startsWith("--")) continue;
  positional.push(args[i]);
}
const logArg = positional[0];
if (!logArg) {
  process.stderr.write("usage: node scripts/watch-bot-liquidations.mjs <logPath> [--all-evals] [--backlog N] [--once]\n");
  process.exit(2);
}

const logPath = resolve(logArg);
try {
  statSync(logPath);
} catch {
  process.stderr.write(`log_not_found: ${logPath}\n`);
  process.exit(1);
}

followLog(logPath);
