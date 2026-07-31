/**
 * Pure formatters for watch-bot --liquidations mode.
 * Keeps noisy healthy HF evals out unless --all-evals.
 */

export const ALWAYS_MSGS = new Set([
  "transaction_sent",
  "liquidation_executed",
  "liquidation_first_attempt",
  "liquidation_dry_run_preview",
  "liquidation_path_candidate",
  "event_purity_liquidatable_candidate",
  "liquidatable_candidate_preview",
  "candidate_execution_uncaught",
  "execution_rejected_hf_not_liquidatable",
  "execution_rejected_single_opportunity_busy",
  "execution_rejected_recent_attempt_inflight",
  "flash_loan_preview_rejected",
  "execution_circuit_open",
  "deployment_safety_gate_blocked",
  "pipeline_cycle_diagnostics",
  "pipeline_cycle_complete",
]);

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
  bgRed: "\u001b[41;37;1m",
  bgGreen: "\u001b[42;30;1m",
  bgYellow: "\u001b[43;30;1m",
};

/** @typedef {"critical"|"sent"|"attempt"|"fail"|"interesting"|"cycle"|"eval"} Tier */

/**
 * @param {Record<string, unknown>} row
 * @param {{ allEvals?: boolean }} [opts]
 * @returns {Tier | null}
 */
export function classifyEvent(row, opts = {}) {
  const msg = String(row.msg ?? "");
  const level = Number(row.level ?? 0);
  const skip = String(row.skipReason ?? "");
  const pass = row.pass === true || row.passed === true;
  const near = row.nearLiquidation === true;

  if (level >= 50 || msg === "candidate_execution_uncaught" || msg === "deployment_safety_gate_blocked") {
    return "critical";
  }
  if (msg === "transaction_sent" || msg === "liquidation_executed") {
    return "sent";
  }
  if (
    msg === "liquidation_first_attempt"
    || msg === "liquidation_dry_run_preview"
    || msg === "event_purity_liquidatable_candidate"
    || msg === "liquidatable_candidate_preview"
    || msg === "liquidation_path_candidate"
  ) {
    return "attempt";
  }
  if (
    level >= 40
    || msg.startsWith("execution_rejected_")
    || msg === "flash_loan_preview_rejected"
    || msg === "execution_circuit_open"
  ) {
    return "fail";
  }
  if (msg === "pipeline_cycle_diagnostics" || msg === "pipeline_cycle_complete") {
    return "cycle";
  }
  if (msg === "liquidation_evaluated") {
    if (pass || near) return "interesting";
    if (skip.startsWith("below_effective_floor")) return "interesting";
    if (/^hf_1\.0/.test(skip)) return "interesting";
    if (opts.allEvals) return "eval";
    return null;
  }
  if (ALWAYS_MSGS.has(msg)) return "interesting";
  return null;
}

function paint(colorEnabled, code, text) {
  if (!colorEnabled) return text;
  return `${code}${text}${ANSI.reset}`;
}

function shortAccount(value) {
  const s = String(value ?? "");
  if (s.length < 12) return s || "—";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function shortTime(value) {
  const s = String(value ?? "");
  const match = s.match(/T(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? s.slice(11, 19) ?? "??:??:??";
}

function fmtNum(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function tierBadge(tier, colorEnabled) {
  switch (tier) {
    case "critical":
      return paint(colorEnabled, ANSI.bgRed, " FAIL ");
    case "sent":
      return paint(colorEnabled, ANSI.bgGreen, " SENT ");
    case "attempt":
      return paint(colorEnabled, ANSI.bgYellow, " TRY  ");
    case "fail":
      return paint(colorEnabled, ANSI.red + ANSI.bold, " WARN ");
    case "interesting":
      return paint(colorEnabled, ANSI.cyan + ANSI.bold, " LIQ  ");
    case "cycle":
      return paint(colorEnabled, ANSI.magenta, " CYCLE");
    case "eval":
      return paint(colorEnabled, ANSI.dim, " eval ");
    default: {
      const _exhaustive = tier;
      return String(_exhaustive);
    }
  }
}

/**
 * @param {Record<string, unknown>} row
 * @param {Tier} tier
 * @param {{ color?: boolean }} [opts]
 */
export function formatEvent(row, tier, opts = {}) {
  const color = opts.color !== false && Boolean(process.stdout.isTTY || opts.color === true);
  const msg = String(row.msg ?? "");
  const time = shortTime(row.time);
  const badge = tierBadge(tier, color);
  const account = row.account != null ? shortAccount(row.account) : "";

  if (msg === "pipeline_cycle_complete" || msg === "pipeline_cycle_diagnostics") {
    const summary = typeof row.summary === "string" ? row.summary : "";
    const evals = row.evaluations ?? "?";
    const sent = row.sent ?? 0;
    const sims = row.sims ?? row.simulated ?? 0;
    const failed = row.failed ?? 0;
    const passed = typeof summary === "string" && summary.includes("passed=")
      ? (summary.match(/passed=(\d+)/)?.[1] ?? "?")
      : (row.passed ?? "?");
    const top = typeof summary === "string"
      ? (summary.match(/top_skips=([^"]+)/)?.[1] ?? "")
      : "";
    const sentPart = Number(sent) > 0
      ? paint(color, ANSI.green + ANSI.bold, `sent=${sent}`)
      : `sent=${sent}`;
    const failPart = Number(failed) > 0
      ? paint(color, ANSI.red + ANSI.bold, `failed=${failed}`)
      : `failed=${failed}`;
    const head = `${badge} ${paint(color, ANSI.dim, time)}  ${paint(color, ANSI.bold, msg)}`;
    const body = `evals=${evals} passed=${passed} sims=${sims} ${sentPart} ${failPart}`;
    return top ? `${head}\n         ${body}\n         ${paint(color, ANSI.dim, `skips: ${top}`)}` : `${head}\n         ${body}`;
  }

  if (msg === "liquidation_evaluated") {
    const hf = row.hfFloat != null ? fmtNum(row.hfFloat, 4) : "—";
    const pass = row.pass === true;
    const near = row.nearLiquidation === true;
    const skip = String(row.skipReason ?? (pass ? "PASS" : "—"));
    const passTag = pass
      ? paint(color, ANSI.green + ANSI.bold, "PASS")
      : near
        ? paint(color, ANSI.yellow + ANSI.bold, "NEAR")
        : paint(color, ANSI.dim, "skip");
    const skipPaint = skip.startsWith("below_effective_floor")
      ? paint(color, ANSI.yellow, skip)
      : pass
        ? paint(color, ANSI.green, skip)
        : paint(color, ANSI.dim, skip);
    return `${badge} ${paint(color, ANSI.dim, time)}  ${passTag}  ${paint(color, ANSI.bold, account)}  hf=${paint(color, ANSI.cyan, hf)}  ${skipPaint}`;
  }

  if (msg === "transaction_sent" || msg === "liquidation_executed") {
    const hash = row.txHash ?? row.hash ?? row.transactionHash ?? "";
    const hashShort = hash ? shortAccount(hash) : "";
    return `${badge} ${paint(color, ANSI.dim, time)}  ${paint(color, ANSI.green + ANSI.bold, msg)}  ${paint(color, ANSI.bold, account)}${hashShort ? `  tx=${hashShort}` : ""}`;
  }

  if (tier === "critical" || tier === "fail") {
    const err = row.error != null ? String(row.error).slice(0, 120) : "";
    const reason = row.skipReason ?? row.reason ?? (Array.isArray(row.reasons) ? row.reasons.join(",") : "");
    const detail = err || reason || "";
    return `${badge} ${paint(color, ANSI.dim, time)}  ${paint(color, ANSI.red + ANSI.bold, msg)}  ${paint(color, ANSI.bold, account)}${detail ? `  ${paint(color, ANSI.yellow, String(detail).slice(0, 100))}` : ""}`;
  }

  if (tier === "attempt") {
    const net = row.netDeltaUsd != null ? `net=$${fmtNum(row.netDeltaUsd, 4)}` : "";
    const gross = row.grossProfitUsd != null ? `gross=$${fmtNum(row.grossProfitUsd, 4)}` : "";
    const extra = [gross, net].filter(Boolean).join("  ");
    return `${badge} ${paint(color, ANSI.dim, time)}  ${paint(color, ANSI.yellow + ANSI.bold, msg)}  ${paint(color, ANSI.bold, account)}${extra ? `  ${extra}` : ""}`;
  }

  const skip = row.skipReason != null ? String(row.skipReason) : "";
  return `${badge} ${paint(color, ANSI.dim, time)}  ${msg}  ${paint(color, ANSI.bold, account)}${skip ? `  ${paint(color, ANSI.dim, skip)}` : ""}`;
}

/**
 * @param {string} line
 * @param {{ allEvals?: boolean, color?: boolean }} [opts]
 * @returns {string | null}
 */
export function formatLogLine(line, opts = {}) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let row;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (row == null || typeof row !== "object") return null;
  const tier = classifyEvent(/** @type {Record<string, unknown>} */ (row), opts);
  if (tier == null) return null;
  return formatEvent(/** @type {Record<string, unknown>} */ (row), tier, opts);
}
