#!/usr/bin/env node
/**
 * P0 combined gate checker — scans soak log for atomic 30-minute window criteria.
 * Usage: node scripts/preflight-p0-gate.mjs <logPath>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const logPath = resolve(process.argv[2] ?? "");
if (!logPath) {
  console.error("usage: node scripts/preflight-p0-gate.mjs <logPath>");
  process.exit(2);
}

const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
const events = [];
for (const line of lines) {
  try {
    const row = JSON.parse(line);
    if (row.time) {
      events.push(row);
    }
  } catch {
    // skip
  }
}

const WINDOW_MS = 30 * 60 * 1_000;
const GAP_QUIET_MS = 5 * 60 * 1_000;

function evaluateWindow(startIdx) {
  const startMs = Date.parse(events[startIdx].time);
  const endMs = startMs + WINDOW_MS;
  const slice = events.filter((row) => {
    const t = Date.parse(row.time);
    return t >= startMs && t <= endMs;
  });

  const failures = [];
  const infoSkips = slice.filter((row) => row.msg === "hf_skip_price_incomplete" && row.level <= 30);
  if (infoSkips.length > 0) {
    failures.push("hf_skip_price_incomplete_at_info");
  }

  const gapRows = slice.filter((row) => row.msg === "hf_price_gap_summary");
  const lastGap = gapRows[gapRows.length - 1];
  const quietGap = slice.filter((row) => {
    const t = Date.parse(row.time);
    return t >= endMs - GAP_QUIET_MS && row.msg === "hf_price_gap_summary" && (row.totalSkips ?? 0) > 0;
  });
  if (quietGap.length > 0) {
    failures.push("hf_price_gap_summary_nonzero_in_last_5m");
  }

  const coverage = slice.filter((row) => row.msg === "oracle_bootstrap_coverage").at(-1);
  if (coverage !== undefined && (coverage.covered_pct ?? 0) < 99) {
    failures.push("oracle_coverage_below_99");
  }

  const fnRow = slice.filter((row) => row.msg === "event_purity_runtime_snapshot").at(-1);
  if (fnRow !== undefined && (fnRow.shadow_false_negative_total ?? 0) > 0) {
    failures.push("shadow_false_negative_total_gt_0");
  }

  const memoryStats = slice.filter((row) => row.msg === "memory_stats");
  if (memoryStats.length >= 2) {
    const rss30 = memoryStats.find((row) => Date.parse(row.time) >= startMs + 25 * 60_000);
    const rssEnd = memoryStats[memoryStats.length - 1];
    if (rss30 && rssEnd) {
      const slopePerMin = (rssEnd.rssMb - rss30.rssMb) / 5;
      if (slopePerMin > 10 / 60) {
        failures.push("rss_slope_exceeds_10_mb_per_h");
      }
    }
  }

  const critical = slice.filter((row) => row.level === 50 || row.msg === "memory_ceiling_hit");
  if (critical.length > 0) {
    failures.push("critical_errors_present");
  }

  return { startMs, endMs, failures, gapSummaryTotal: lastGap?.totalSkips ?? null };
}

let best;
for (let i = 0; i < events.length; i += 1) {
  const result = evaluateWindow(i);
  if (result.failures.length === 0) {
    best = result;
    break;
  }
  if (best === undefined || result.failures.length < best.failures.length) {
    best = result;
  }
}

if (best !== undefined && best.failures.length === 0) {
  console.log(JSON.stringify({ event: "p0_gate_pass", windowStart: new Date(best.startMs).toISOString() }));
  process.exit(0);
}

console.error(JSON.stringify({
  event: "p0_gate_fail",
  failures: best?.failures ?? ["no_events"],
  gapSummaryTotal: best?.gapSummaryTotal,
}));
process.exit(1);
