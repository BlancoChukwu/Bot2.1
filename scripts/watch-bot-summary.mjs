/**
 * Dense ops + liquidations summary for watch-bot.sh (single-pass log scan).
 * Usage: node scripts/watch-bot-summary.mjs <logPath> [--json] [--mode soak|live|unknown]
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { rssGrowthMbPerHour, rssGrowthMbPerHourFullWindow } from "./rssGrowth.mjs";

const logPath = resolve(process.argv[2] ?? "");
const jsonOut = process.argv.includes("--json");
const modeArgIdx = process.argv.indexOf("--mode");
const modeOverride = modeArgIdx >= 0 ? String(process.argv[modeArgIdx + 1] ?? "unknown") : undefined;

const FATAL_MSGS = new Set([
  "deployment_safety_gate_blocked",
  "uncaught_exception",
  "single_instance_lock_rejected",
  "memory_ceiling_hit",
]);

const LIQ_COUNT_KEYS = [
  "event_purity_liquidatable_candidate",
  "liquidatable_candidate_preview",
  "liquidatable_candidate_detected_gate_closed",
  "liquidation_dry_run_preview",
  "liquidation_evaluated",
  "liquidation_first_attempt",
  "opportunity_trace_cycle",
  "liquidation_path_candidate",
  "execution_rejected_hf_not_liquidatable",
  "execution_rejected_single_opportunity_busy",
  "execution_rejected_recent_attempt_inflight",
  "flash_loan_preview_rejected",
  "liquidation_dust_filtered",
  "execution_circuit_open",
  "transaction_sent",
  "liquidation_executed",
  "candidate_execution_uncaught",
];

const ATTEMPT_MSGS = new Set([
  "liquidation_first_attempt",
  "opportunity_trace_cycle",
  "liquidation_dry_run_preview",
  "liquidation_evaluated",
  "transaction_sent",
  "liquidation_executed",
  "execution_rejected_hf_not_liquidatable",
  "execution_rejected_single_opportunity_busy",
  "execution_rejected_recent_attempt_inflight",
  "flash_loan_preview_rejected",
  "execution_circuit_open",
  "deployment_safety_gate_blocked",
]);

/** Lifecycle / heartbeat msgs so cockpit Activity stream is not empty on a healthy idle bot. */
const LIFECYCLE_MSGS = new Set([
  "ws_event_layer_started",
  "event_purity_runtime_snapshot",
  "memory_stats",
  "launcher_session_exit",
  "single_instance_lock_acquired",
  "bootstrap_complete",
  "gap_fill_refresh_poll_result",
  "oracle_poll_tick",
  "hybrid_detection_layer_started",
  "position_cache_warmed",
]);

const RECENT_ATTEMPT_CAP = 40;
const RECENT_LIFECYCLE_CAP = 30;
/** Cap full-file scans so SSH cockpit polls do not OOM / timeout on huge soak logs. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function readLogLines(path) {
  const st = statSync(path);
  let buffer;
  if (st.size > MAX_LOG_BYTES) {
    const fd = openSync(path, "r");
    try {
      buffer = Buffer.alloc(MAX_LOG_BYTES);
      readSync(fd, buffer, 0, MAX_LOG_BYTES, st.size - MAX_LOG_BYTES);
    } finally {
      closeSync(fd);
    }
  } else {
    buffer = readFileSync(path);
  }
  const encoding = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? "utf16le"
    : "utf8";
  const text = buffer.toString(encoding);
  // When tailing, drop the first partial line.
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (st.size > MAX_LOG_BYTES && lines.length > 1) {
    lines.shift();
  }
  return lines;
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

function shortAccount(value) {
  if (typeof value !== "string" || value.length < 12) return value ?? "?";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function inferModeFromPath(path) {
  const lower = path.toLowerCase();
  if (lower.includes("soak") || lower.includes("simulation")) return "soak";
  if (lower.includes("production") || lower.includes("live")) return "live";
  return "unknown";
}

if (!logPath) {
  console.error("usage: node scripts/watch-bot-summary.mjs <logPath> [--json] [--mode soak|live|unknown]");
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
  gap_fill_refresh_poll_result: 0,
  oracle_poll_tick: 0,
  hybrid_detection_failure: 0,
  partial_bootstrap_getlogs_retry: 0,
  hf_price_gap_summary: 0,
  deployment_safety_gate_blocked: 0,
  watchlist_stale: 0,
  watchlist_stale_critical: 0,
  watchlist_heartbeat: 0,
  watchlist_stale_alert_sent: 0,
  /** Diagnostic HF samples — excluded from liquidations.evaluated. */
  liquidation_evaluated_diag: 0,
};
for (const key of LIQ_COUNT_KEYS) {
  counts[key] = 0;
}

let firstTs;
let lastTs;
let lastMemory;
let lastRuntimeSnapshot;
let lastShadowAggregate;
let lastGapFillRefresh;
let wsStarted = false;
let simModeHint;
const rssSamples = [];
let lastWatchlistStale;
const recentCritical = [];
const recentAttempts = [];
const recentLifecycle = [];

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

  if (row.simulationMode === true || row.simulation_mode === true || row.SIMULATION_MODE === true) {
    simModeHint = "soak";
  } else if (row.simulationMode === false || row.simulation_mode === false || row.SIMULATION_MODE === false) {
    simModeHint = "live";
  }

  if (row.level === 50) counts.critical_errors += 1;
  if (FATAL_MSGS.has(msg) || msg.endsWith("_critical")) {
    recentCritical.push({
      time: row.time,
      msg,
      error: row.error,
      reasons: row.reasons,
      ageMs: row.ageMs,
    });
    if (recentCritical.length > 5) recentCritical.shift();
  }

  if (msg === "watchlist_stale" || msg === "watchlist_stale_critical") {
    lastWatchlistStale = {
      time: row.time,
      msg,
      ageMs: row.ageMs,
      consecutive: row.consecutive,
    };
  }

  if (msg in counts) {
    counts[msg] += 1;
  }
  if (msg === "liquidation_evaluated" && row.stage === "pipeline_cycle_sample") {
    counts.liquidation_evaluated_diag += 1;
  }

  if (ATTEMPT_MSGS.has(msg)) {
    recentAttempts.push({
      time: row.time,
      msg,
      account: row.account ?? row.borrower ?? row.user,
      phase: row.phase,
      simOk: row.sim_ok ?? row.simOk,
      opportunityId: row.opportunityId,
      reasons: row.reasons,
    });
    if (recentAttempts.length > RECENT_ATTEMPT_CAP) recentAttempts.shift();
  }

  if (LIFECYCLE_MSGS.has(msg)) {
    recentLifecycle.push({
      time: row.time,
      msg,
      detail:
        msg === "event_purity_runtime_snapshot"
          ? `seeded=${row.usersSeeded ?? "?"}`
          : msg === "memory_stats"
            ? `rssMb=${row.rssMb ?? "?"}`
            : msg === "gap_fill_refresh_poll_result"
              ? `refreshed=${row.refreshed ?? 0}`
              : undefined,
    });
    if (recentLifecycle.length > RECENT_LIFECYCLE_CAP) recentLifecycle.shift();
  }

  switch (msg) {
    case "memory_stats":
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
    case "ws_event_layer_started":
      wsStarted = true;
      break;
    default:
      break;
  }
}

const rejectedTotal =
  counts.execution_rejected_hf_not_liquidatable
  + counts.execution_rejected_single_opportunity_busy
  + counts.execution_rejected_recent_attempt_inflight
  + counts.flash_loan_preview_rejected
  + counts.liquidation_dust_filtered;
const evaluatedGate = counts.liquidation_evaluated - counts.liquidation_evaluated_diag;

const mode = modeOverride && modeOverride !== "unknown"
  ? modeOverride
  : (simModeHint ?? inferModeFromPath(logPath));

const isSoak = mode === "soak";
const windowMs = firstTs && lastTs ? Date.parse(lastTs) - Date.parse(firstTs) : undefined;
const rssPostWarmup = Number(rssGrowthMbPerHour(rssSamples).toFixed(2));
const rssFullWindow = Number(rssGrowthMbPerHourFullWindow(rssSamples).toFixed(2));
const healthy =
  counts.critical_errors === 0
  && counts.memory_ceiling_hit === 0
  && counts.position_on_chain_reconcile_failed === 0
  && counts.hybrid_detection_failure === 0
  && counts.deployment_safety_gate_blocked === 0
  && counts.execution_circuit_open === 0;

const summary = {
  logPath,
  logSizeMb: Number((logSizeBytes / 1024 / 1024).toFixed(2)),
  mode,
  window: { firstTs, lastTs, duration: windowMs === undefined ? undefined : formatDuration(windowMs) },
  wsEventLayerStarted: wsStarted,
  counts,
  liquidations: {
    candidates: counts.event_purity_liquidatable_candidate,
    previews: counts.liquidatable_candidate_preview,
    gateClosed: counts.liquidatable_candidate_detected_gate_closed,
    evaluated: evaluatedGate,
    evaluatedDiag: counts.liquidation_evaluated_diag,
    pathCandidates: counts.liquidation_path_candidate,
    dryRuns: counts.liquidation_dry_run_preview,
    firstAttempts: counts.liquidation_first_attempt,
    opportunityTraces: counts.opportunity_trace_cycle,
    rejected: rejectedTotal,
    rejectedDetail: {
      hfNotLiquidatable: counts.execution_rejected_hf_not_liquidatable,
      busy: counts.execution_rejected_single_opportunity_busy,
      inflight: counts.execution_rejected_recent_attempt_inflight,
      flashPreview: counts.flash_loan_preview_rejected,
      dustFiltered: counts.liquidation_dust_filtered,
    },
    circuitOpen: counts.execution_circuit_open,
    sent: counts.transaction_sent,
    executed: counts.liquidation_executed,
    uncaught: counts.candidate_execution_uncaught,
    safetyGateBlocked: counts.deployment_safety_gate_blocked,
  },
  rssGrowthMbPerHour: rssPostWarmup,
  rssGrowthMbPerHourFullWindow: rssFullWindow,
  lastMemory,
  lastRuntimeSnapshot,
  lastShadowAggregate,
  lastGapFillRefresh,
  recentCritical,
  recentAttempts,
  recentLifecycle,
  watchlistStaleness: {
    stale: counts.watchlist_stale,
    critical: counts.watchlist_stale_critical,
    heartbeats: counts.watchlist_heartbeat,
    alertsSent: counts.watchlist_stale_alert_sent,
    lastAgeMs: lastWatchlistStale?.ageMs,
    lastAt: lastWatchlistStale?.time,
    lastConsecutive: lastWatchlistStale?.consecutive,
  },
  healthy,
};

if (jsonOut) {
  // Compact JSON — pretty-print blows SSH payload size for cockpit polls.
  console.log(JSON.stringify(summary));
  process.exit(summary.healthy ? 0 : 1);
}

const modeLabel = isSoak
  ? "soak (no live TX) — attempts = dry-run / sim / evaluated"
  : mode === "live"
    ? "live — sent/executed count real txs"
    : "mode unknown — treat sent/executed cautiously";

console.log("── Liquidations ──");
console.log(`  Mode:         ${modeLabel}`);
console.log(`  Candidates:   found=${summary.liquidations.candidates} preview=${summary.liquidations.previews} path=${summary.liquidations.pathCandidates} gate_closed=${summary.liquidations.gateClosed}`);
console.log(`  Pipeline:     evaluated=${summary.liquidations.evaluated} diag=${summary.liquidations.evaluatedDiag} first_attempt=${summary.liquidations.firstAttempts} traces=${summary.liquidations.opportunityTraces}`);
console.log(`  Dry-run/sim:  ${summary.liquidations.dryRuns}`);
console.log(
  `  Rejected:     ${summary.liquidations.rejected}`
  + ` (hf=${summary.liquidations.rejectedDetail.hfNotLiquidatable}`
  + ` busy=${summary.liquidations.rejectedDetail.busy}`
  + ` inflight=${summary.liquidations.rejectedDetail.inflight}`
  + ` flash=${summary.liquidations.rejectedDetail.flashPreview}`
  + ` dust=${summary.liquidations.rejectedDetail.dustFiltered})`,
);
if (isSoak) {
  console.log(`  Sent/exec:    n/a in soak (dry-run only) | circuit_open=${summary.liquidations.circuitOpen}`);
} else {
  console.log(`  Sent/exec:    sent=${summary.liquidations.sent} executed=${summary.liquidations.executed} uncaught=${summary.liquidations.uncaught} circuit_open=${summary.liquidations.circuitOpen}`);
}
if (summary.liquidations.safetyGateBlocked > 0) {
  console.log(`  Safety gate:  BLOCKED x${summary.liquidations.safetyGateBlocked} — run dry-run receipt then restart live`);
}
if (recentAttempts.length > 0) {
  console.log("  Recent:");
  for (const row of recentAttempts.slice(-5)) {
    const bits = [row.time ?? "?", row.msg];
    if (row.account) bits.push(shortAccount(String(row.account)));
    if (row.phase) bits.push(`phase=${row.phase}`);
    if (row.simOk !== undefined) bits.push(`sim=${row.simOk}`);
    console.log(`    ${bits.join(" ")}`);
  }
} else {
  console.log("  Recent:       (none yet this session)");
}

console.log("");
console.log("── Health ──");
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
if (lastGapFillRefresh || counts.gap_fill_refresh_poll_result > 0) {
  const tickNote = counts.oracle_poll_tick > 0 ? ` ticks=${counts.oracle_poll_tick}` : "";
  console.log(
    `  Gap-fill:     polls=${counts.gap_fill_refresh_poll_result}${tickNote} last refreshed=${lastGapFillRefresh?.refreshed ?? "?"} target=${lastGapFillRefresh?.targetCount ?? "?"} failed=${lastGapFillRefresh?.failedCount ?? "?"}`,
  );
} else {
  console.log("  Gap-fill:     no refresh poll logs (rebuild + restart required)");
}
console.log(`  Critical:     level50=${counts.critical_errors} ceiling=${counts.memory_ceiling_hit} hybrid_fail=${counts.hybrid_detection_failure} mem_warn=${counts.memory_warning}`);
console.log(`  Status:       ${summary.healthy ? "OK" : "ATTENTION NEEDED"}`);
