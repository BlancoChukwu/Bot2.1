/**
 * Compact session summary for watch-bot.sh (single-pass log scan).
 * Usage: node scripts/watch-bot-summary.mjs <logPath> [--json]
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { rssGrowthMbPerHour, rssGrowthMbPerHourFullWindow } from "./rssGrowth.mjs";

const logPath = resolve(process.argv[2] ?? "");
const jsonOut = process.argv.includes("--json");

const FATAL_MSGS = new Set([
  "deployment_safety_gate_blocked",
  "uncaught_exception",
  "single_instance_lock_rejected",
  "memory_ceiling_hit",
]);

function readLogLines(path) {
  const buffer = readFileSync(path);
  const encoding = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? "utf16le"
    : "utf8";
  return buffer.toString(encoding).split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

if (!logPath) {
  console.error("usage: node scripts/watch-bot-summary.mjs <logPath> [--json]");
  process.exit(2);
}

let logSizeBytes = 0;
try {
  logSizeBytes = statSync(logPath).size;
} catch {
  const err = { error: "log_not_found", logPath };
  if (jsonOut) {
    console.log(JSON.stringify(err));
  } else {
    console.log(`Log not found: ${logPath}`);
  }
  process.exit(1);
}

const counts = {
  critical_errors: 0,
  memory_ceiling_hit: 0,
  memory_warning: 0,
  memory_stats: 0,
  position_first_touch_reconciled: 0,
  position_first_touch_reconcile_skipped: 0,
  position_on_chain_reconcile_failed: 0,
  shadow_sample_skipped: 0,
  event_purity_liquidatable_candidate: 0,
  gap_fill_refresh_poll_result: 0,
  oracle_poll_tick: 0,
  hybrid_detection_failure: 0,
  partial_bootstrap_getlogs_retry: 0,
  hf_price_gap_summary: 0,
};

let firstTs;
let lastTs;
let lastMemory;
let lastRuntimeSnapshot;
let lastShadowAggregate;
let lastGapFillRefresh;
let wsStarted = false;
const rssSamples = [];
const recentCritical = [];

for (const rawLine of readLogLines(logPath)) {
  let row;
  try {
    row = JSON.parse(rawLine.trim());
  } catch {
    continue;
  }

  if (row.time !== undefined) {
    if (firstTs === undefined) firstTs = row.time;
    lastTs = row.time;
  }

  const msg = row.msg;
  if (typeof msg !== "string") continue;

  if (row.level === 50) counts.critical_errors += 1;
  if (FATAL_MSGS.has(msg) || (typeof msg === "string" && msg.endsWith("_critical"))) {
    recentCritical.push({ time: row.time, msg, error: row.error, reasons: row.reasons });
    if (recentCritical.length > 5) recentCritical.shift();
  }

  if (msg in counts && msg !== "memory_stats" && msg !== "memory_ceiling_hit" && msg !== "memory_warning") {
    counts[msg] += 1;
  }

  switch (msg) {
    case "memory_stats":
      counts.memory_stats += 1;
      lastMemory = {
        time: row.time,
        heapUsedMb: row.heapUsedMb,
        rssMb: row.rssMb,
        watchlistSize: row.components?.watchlistSize,
      };
      if (typeof row.rssMb === "number" && row.time) {
        rssSamples.push({ timeMs: Date.parse(row.time), rssMb: row.rssMb });
      }
      break;
    case "event_purity_runtime_snapshot":
      lastRuntimeSnapshot = {
        time: row.time,
        positionCacheSize: row.position_cache_size,
        bootstrapCoveragePct: row.bootstrap_coverage_pct,
        livePositionCoveragePct: row.live_position_coverage_pct,
        bootstrapDebtorCoveragePctAtBoot: row.bootstrap_debtor_coverage_pct_at_boot,
        positionCacheHardCap: row.position_cache_hard_cap,
        positionCacheAtHardCap: row.position_cache_at_hard_cap,
        bootstrapSource: row.bootstrapSource,
        usersSeeded: row.usersSeeded,
        shadowFalseNegativeTotal: row.shadow_false_negative_total,
        blockNumber: row.blockNumber,
      };
      break;
    case "shadow_validation_aggregate":
      lastShadowAggregate = {
        time: row.time,
        totalSamples: row.totalSamples,
        shadowDriftNonEModeBps: row.shadow_drift_non_eMode_bps,
        shadowFnRateNonEModePct: row.shadow_fn_rate_non_eMode_pct,
        nonEModeWithinDriftTolerance: row.non_eMode_within_drift_tolerance,
        nonEModeWithinFnTarget: row.non_eMode_within_fn_target,
      };
      break;
    case "gap_fill_refresh_poll_result":
      lastGapFillRefresh = {
        time: row.time,
        refreshed: row.refreshed,
        failedCount: row.failedCount,
        targetCount: row.targetCount,
        skipped: row.skipped,
        skipReason: row.skipReason,
      };
      break;
    case "oracle_poll_timer_started":
      break;
    case "hf_price_gap_summary":
      counts.hf_price_gap_summary += 1;
      break;
    case "ws_event_layer_started":
      wsStarted = true;
      break;
    case "memory_ceiling_hit":
      counts.memory_ceiling_hit += 1;
      break;
    case "memory_warning":
      counts.memory_warning += 1;
      break;
    default:
      break;
  }
}

const windowMs = firstTs && lastTs ? Date.parse(lastTs) - Date.parse(firstTs) : undefined;
const rssPostWarmup = Number(rssGrowthMbPerHour(rssSamples).toFixed(2));
const rssFullWindow = Number(rssGrowthMbPerHourFullWindow(rssSamples).toFixed(2));
const summary = {
  logPath,
  logSizeMb: Number((logSizeBytes / 1024 / 1024).toFixed(2)),
  window: { firstTs, lastTs, duration: windowMs === undefined ? undefined : formatDuration(windowMs) },
  wsEventLayerStarted: wsStarted,
  counts,
  rssGrowthMbPerHour: rssPostWarmup,
  rssGrowthMbPerHourFullWindow: rssFullWindow,
  lastMemory,
  lastRuntimeSnapshot,
  lastShadowAggregate,
  recentCritical,
  healthy:
    counts.critical_errors === 0
    && counts.memory_ceiling_hit === 0
    && counts.position_on_chain_reconcile_failed === 0
    && counts.hybrid_detection_failure === 0,
};

if (jsonOut) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.healthy ? 0 : 1);
}

console.log("── Session summary ──");
console.log(`  Log size:     ${summary.logSizeMb} MB`);
if (summary.window.firstTs) {
  console.log(`  Window:       ${summary.window.firstTs} → ${summary.window.lastTs ?? "now"} (${summary.window.duration ?? "?"})`);
}
console.log(`  WS layer:     ${wsStarted ? "started" : "not seen in log yet"}`);
if (lastRuntimeSnapshot) {
  const liveCov = lastRuntimeSnapshot.livePositionCoveragePct
    ?? lastRuntimeSnapshot.bootstrapCoveragePct;
  const bootCov = lastRuntimeSnapshot.bootstrapDebtorCoveragePctAtBoot;
  console.log(`  Bootstrap:    source=${lastRuntimeSnapshot.bootstrapSource ?? "?"} seeded=${lastRuntimeSnapshot.usersSeeded ?? "?"} cache=${lastRuntimeSnapshot.positionCacheSize ?? "?"} liveCoverage=${liveCov?.toFixed?.(1) ?? "?"}% bootDebtorCov=${bootCov?.toFixed?.(1) ?? "n/a"}% atCap=${lastRuntimeSnapshot.positionCacheAtHardCap ?? "?"} block=${lastRuntimeSnapshot.blockNumber ?? "?"}`);
  console.log(`  Shadow FN:    ${lastRuntimeSnapshot.shadowFalseNegativeTotal ?? 0}`);
}
if (lastShadowAggregate) {
  console.log(`  Shadow agg:   samples=${lastShadowAggregate.totalSamples ?? 0} drift=${lastShadowAggregate.shadowDriftNonEModeBps ?? 0}bps fnRate=${lastShadowAggregate.shadowFnRateNonEModePct ?? 0}%`);
}
if (lastMemory) {
  console.log(`  Memory:       heap=${lastMemory.heapUsedMb ?? "?"}MB rss=${lastMemory.rssMb ?? "?"}MB watchlist=${lastMemory.watchlistSize ?? "?"} (rss slope post-warmup ${summary.rssGrowthMbPerHour} MB/h; full-window ${summary.rssGrowthMbPerHourFullWindow} MB/h)`);
}
console.log(`  Reconcile:    ok=${counts.position_first_touch_reconciled} skipped=${counts.position_first_touch_reconcile_skipped} failed=${counts.position_on_chain_reconcile_failed}`);
console.log(`  Candidates:   ${counts.event_purity_liquidatable_candidate} liquidatable | bootstrap retries=${counts.partial_bootstrap_getlogs_retry}`);
if (lastGapFillRefresh || counts.gap_fill_refresh_poll_result > 0) {
  const tickNote = counts.oracle_poll_tick > 0 ? ` ticks=${counts.oracle_poll_tick}` : "";
  console.log(
    `  Gap-fill:     polls=${counts.gap_fill_refresh_poll_result}${tickNote} last refreshed=${lastGapFillRefresh?.refreshed ?? "?"} target=${lastGapFillRefresh?.targetCount ?? "?"} failed=${lastGapFillRefresh?.failedCount ?? "?"}`,
  );
} else {
  console.log("  Gap-fill:     no refresh poll logs (rebuild + restart required)");
}
console.log(`  Critical:     level50=${counts.critical_errors} ceiling=${counts.memory_ceiling_hit} hybrid_fail=${counts.hybrid_detection_failure}`);
if (recentCritical.length > 0) {
  console.log("  Recent critical:");
  for (const row of recentCritical) {
    console.log(`    ${row.time ?? "?"} ${row.msg}`);
  }
}
console.log(`  Status:       ${summary.healthy ? "OK" : "CHECK WARNINGS"}`);
