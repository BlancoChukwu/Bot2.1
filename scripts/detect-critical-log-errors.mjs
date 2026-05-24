/**
 * Scan bot JSON log lines for critical errors (level 50 or fatal msgs).
 * Usage: node scripts/detect-critical-log-errors.mjs <logPath> [--offset <bytes>]
 * Exit 0 when none found; exit 1 when critical errors exist (stdout JSON).
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const logPath = resolve(process.argv[2] ?? "");
const offsetArg = process.argv.indexOf("--offset");
const startOffset = offsetArg >= 0 ? Number(process.argv[offsetArg + 1]) : 0;

const FATAL_MSGS = new Set([
  "deployment_safety_gate_blocked",
  "uncaught_exception",
  "single_instance_lock_rejected",
  "memory_ceiling_hit",
]);

function isCritical(row) {
  if (row.level === 50) return true;
  const msg = row.msg;
  if (typeof msg !== "string") return false;
  if (FATAL_MSGS.has(msg)) return true;
  if (msg.endsWith("_critical")) return true;
  return false;
}

function readLogLines(path, offset) {
  const buffer = readFileSync(path);
  const encoding = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? "utf16le"
    : "utf8";
  const text = buffer.toString(encoding, offset);
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

if (!logPath) {
  console.error(JSON.stringify({ error: "missing_log_path" }));
  process.exit(2);
}

let fileSize = 0;
try {
  fileSize = statSync(logPath).size;
} catch {
  console.log(JSON.stringify({ logPath, fileSize: 0, nextOffset: 0, critical: [], count: 0 }));
  process.exit(0);
}

const events = [];
for (const rawLine of readLogLines(logPath, startOffset)) {
  const line = rawLine.trim();
  if (!line.startsWith("{")) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  if (!isCritical(row)) continue;
  events.push({
    time: row.time,
    msg: row.msg,
    level: row.level,
    reasons: row.reasons,
    error: row.error,
    chain: row.chain,
  });
}

const result = {
  logPath,
  fileSize,
  nextOffset: fileSize,
  count: events.length,
  critical: events.slice(-20),
};

console.log(JSON.stringify(result));
process.exit(events.length > 0 ? 1 : 0);
