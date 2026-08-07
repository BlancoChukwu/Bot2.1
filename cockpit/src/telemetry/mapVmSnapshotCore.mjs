/**
 * Pure mapper: watch-bot-summary --json (+ optional HTTP blobs) → CockpitTelemetry.
 * Kept as .mjs so unit tests can import without a TS compile step.
 */

/**
 * @typedef {object} MapVmSnapshotInput
 * @property {string} [summaryJson]
 * @property {string} [healthzJson]
 * @property {string} [statusJson]
 * @property {string} [sessionJson]
 * @property {boolean} [botRunning]
 * @property {Date} [now]
 */

function mountainTime(d = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function utcClock(d = new Date()) {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function safeParse(json, fallback = {}) {
  if (!json || typeof json !== "string") return fallback;
  const trimmed = json.trim();
  if (!trimmed || trimmed === "{}") return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

function shortAccount(account) {
  if (!account || typeof account !== "string") return "?";
  if (account.length < 12) return account;
  return `${account.slice(0, 6)}…${account.slice(-4)}`;
}

function uptimeFromWindow(window) {
  if (!window?.firstTs) return 0;
  const first = Date.parse(window.firstTs);
  const last = window.lastTs ? Date.parse(window.lastTs) : Date.now();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return 0;
  return Math.floor((last - first) / 1000);
}

function emptyTelemetry(now = new Date()) {
  return {
    liveMode: false,
    liveTxEnabled: false,
    botRunning: false,
    circuit: "closed",
    sessionId: "—",
    versionStamp: "DISCONNECTED",
    uptimeSec: 0,
    mountainTime: mountainTime(now),
    seededAccounts: 0,
    liquidatableCount: 0,
    liquidationAttempts: 0,
    rpcStatus: "down",
    lastHealthCheckIso: now.toISOString(),
    chainsReady: [],
    residualPositions: 0,
    meters: { flashLoanSuccessPct: 0 },
    candidates: [],
    watchlist: [],
    hfTraces: [],
    alerts: [],
    stream: [],
    minProfitFloorUsd: 10,
  };
}

function looksLive(blob) {
  const lower = String(blob ?? "").toLowerCase();
  return lower.includes("production") || lower.includes("live");
}

function looksSoak(blob) {
  const lower = String(blob ?? "").toLowerCase();
  return lower.includes("soak") || lower.includes("simulation");
}

/**
 * Resolve live vs soak from summary.mode, session meta, and path hints.
 * Cockpit is live-only ops; we still detect soak accurately if an old session is active.
 */
export function resolveLiveMode(summary = {}, session = {}) {
  if (session.simulationMode === false) return true;
  if (session.simulationMode === true) return false;

  const mode = String(session.mode ?? summary.mode ?? "unknown").toLowerCase();
  if (mode === "live") return true;
  if (mode === "soak") return false;

  const hints = [
    summary.logPath,
    session.log,
    session.prefix,
    session.env_file,
    session.envFile,
  ]
    .filter(Boolean)
    .join(" ");

  if (looksLive(hints)) return true;
  if (looksSoak(hints)) return false;
  return false;
}

/**
 * Resolve ENABLE_LIVE_TX independently of liveMode (soak can be live-path with TX off).
 */
export function resolveLiveTxEnabled(session = {}, liveMode = false, summary = {}) {
  if (session.enableLiveTx === true) return true;
  if (session.enableLiveTx === false) return false;
  // Unknown: production live sessions default armed; soak stays false.
  const hints = [
    session.prefix,
    session.env_file,
    session.envFile,
    session.log,
    summary.logPath,
  ]
    .filter(Boolean)
    .join(" ");
  if (liveMode && looksLive(hints)) return true;
  return false;
}

function pushStreamRow(stream, row, now) {
  const msg = String(row.msg ?? "event");
  const isLiq =
    msg.includes("liquidation") ||
    msg.includes("liquidatable") ||
    msg.includes("transaction_sent") ||
    msg.includes("dry_run") ||
    msg.includes("opportunity_trace");
  const tone =
    msg.includes("reject") || msg.includes("fail") || msg.includes("error") || msg.includes("blocked")
      ? "red"
      : msg.includes("sent") || msg.includes("executed") || msg.includes("started")
        ? "green"
        : isLiq
          ? "amber"
          : "cyan";
  const bits = [];
  if (row.account) bits.push(shortAccount(String(row.account)));
  if (row.phase) bits.push(`phase=${row.phase}`);
  if (row.simOk !== undefined) bits.push(`sim=${row.simOk}`);
  if (row.detail) bits.push(String(row.detail));
  stream.push({
    id: `evt-${row.time ?? stream.length}-${msg}-${stream.length}`,
    time: utcClock(row.time ? new Date(row.time) : now),
    tone,
    kind: msg,
    detail: bits.join(" · ") || msg,
    isLiquidation: isLiq,
  });
}

/**
 * Map a VM telemetry snapshot into CockpitTelemetry (core fields only).
 * Candidates / HF traces / watchlist stay empty in v1.
 *
 * @param {MapVmSnapshotInput} input
 */
export function mapVmSnapshot(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date();
  const summary = safeParse(input.summaryJson, {});
  const healthz = safeParse(input.healthzJson, {});
  const status = safeParse(input.statusJson, {});
  const session = safeParse(input.sessionJson, {});

  const liq = summary.liquidations ?? {};
  const snap = summary.lastRuntimeSnapshot ?? {};
  const liveMode = resolveLiveMode(summary, session);
  const liveTxEnabled = resolveLiveTxEnabled(session, liveMode, summary);
  const circuitOpen = Number(liq.circuitOpen ?? 0) > 0;
  const botRunning =
    typeof input.botRunning === "boolean"
      ? input.botRunning
      : Boolean(
          healthz.ok === true ||
            healthz.status === "ok" ||
            Object.keys(status).length > 0,
        );

  /** @type {Array<{id:string,severity:string,title:string,detail:string,time:string,acknowledged:boolean}>} */
  const alerts = [];
  const recentCritical = Array.isArray(summary.recentCritical) ? summary.recentCritical : [];
  for (const row of recentCritical.slice(-10)) {
    const title = String(row.msg ?? row.title ?? "critical");
    alerts.push({
      id: `crit-${row.time ?? title}-${alerts.length}`,
      severity: "critical",
      title,
      detail: String(row.detail ?? row.reason ?? row.account ?? "Critical log event"),
      time: utcClock(row.time ? new Date(row.time) : now),
      acknowledged: false,
    });
  }
  if (Number(liq.safetyGateBlocked ?? 0) > 0) {
    alerts.unshift({
      id: "safety-gate",
      severity: "critical",
      title: "deployment_safety_gate_blocked",
      detail: `Safety gate blocked ×${liq.safetyGateBlocked} — run dry-run receipt then restart live`,
      time: utcClock(now),
      acknowledged: false,
    });
  }
  if (circuitOpen) {
    alerts.unshift({
      id: "circuit-open",
      severity: "critical",
      title: "execution_circuit_open",
      detail: "Execution circuit is open — liquidations halted until cleared",
      time: utcClock(now),
      acknowledged: false,
    });
  }

  const watchlistStale = summary.watchlistStaleness ?? {};
  const lastWatchlistAgeMs = Number(watchlistStale.lastAgeMs ?? 0);
  const watchlistCriticalCount = Number(watchlistStale.critical ?? 0);
  if (watchlistCriticalCount >= 3 || lastWatchlistAgeMs > 180_000) {
    alerts.unshift({
      id: "watchlist-stale",
      severity: "critical",
      title: "watchlist_stale_critical",
      detail: `Watchlist ageMs=${lastWatchlistAgeMs} critical×${watchlistCriticalCount} — execution may be blocked`,
      time: utcClock(watchlistStale.lastAt ? new Date(watchlistStale.lastAt) : now),
      acknowledged: false,
    });
  }

  /** @type {Array<{id:string,time:string,tone:string,kind:string,detail:string,isLiquidation:boolean}>} */
  const stream = [];
  const recentAttempts = Array.isArray(summary.recentAttempts) ? summary.recentAttempts : [];
  const recentLifecycle = Array.isArray(summary.recentLifecycle) ? summary.recentLifecycle : [];
  const merged = [
    ...recentLifecycle.map((row) => ({ ...row, _rank: 0 })),
    ...recentAttempts.map((row) => ({ ...row, _rank: 1 })),
  ].sort((a, b) => {
    const ta = a.time ? Date.parse(a.time) : 0;
    const tb = b.time ? Date.parse(b.time) : 0;
    if (ta !== tb) return ta - tb;
    return a._rank - b._rank;
  });
  for (const row of merged.slice(-60)) {
    pushStreamRow(stream, row, now);
  }
  // Newest first for the tail panel.
  stream.reverse();

  const seeded =
    Number(status.usersSeeded ?? snap.usersSeeded ?? healthz.usersSeeded ?? 0) || 0;
  const liquidatable = Number(liq.candidates ?? 0) || 0;
  const attempts =
    Number(liq.firstAttempts ?? 0) + Number(liq.sent ?? 0) + Number(liq.executed ?? 0);

  let rpcStatus = "down";
  if (summary.wsEventLayerStarted || Object.keys(healthz).length > 0 || Object.keys(status).length > 0) {
    rpcStatus = summary.healthy === false ? "degraded" : "up";
  } else if (summary.healthy === false || botRunning) {
    rpcStatus = "degraded";
  }

  return {
    liveMode,
    liveTxEnabled,
    botRunning,
    circuit: circuitOpen ? "open" : "closed",
    sessionId: String(summary.logPath ?? session.log ?? "—").split(/[/\\]/).pop() ?? "—",
    versionStamp: liveMode ? "LIVE" : looksSoak(`${summary.mode ?? ""} ${session.prefix ?? ""}`) ? "SOAK" : "UNKNOWN",
    uptimeSec: uptimeFromWindow(summary.window),
    mountainTime: mountainTime(now),
    seededAccounts: seeded,
    liquidatableCount: liquidatable,
    liquidationAttempts: attempts,
    rpcStatus,
    lastHealthCheckIso: now.toISOString(),
    chainsReady: [{ chain: "base", ready: botRunning }],
    residualPositions: 0,
    meters: { flashLoanSuccessPct: 0 },
    candidates: [],
    watchlist: [],
    hfTraces: [],
    alerts: alerts.slice(0, 20),
    stream,
    minProfitFloorUsd: 10,
  };
}

export function createEmptyTelemetry(now = new Date()) {
  return emptyTelemetry(now);
}

export { emptyTelemetry };
