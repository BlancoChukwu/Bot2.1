/**
 * Parse JSON-line bot logs and emit a 24h shadow-validation audit report.
 * Usage: node scripts/audit-session.mjs [logPath]
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const logPath = resolve(process.argv[2] ?? "logs/live-24h.log");

function readLogLines(path) {
  const buffer = readFileSync(path);
  const encoding = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? "utf16le"
    : "utf8";
  return buffer.toString(encoding).split(/\r?\n/).filter((line) => line.trim().length > 0);
}
const maxLogBytes = 25 * 1024 * 1024;
const dustDedupeWindowMs = 60_000;

const counts = {
  liquidation_evaluated: 0,
  arbitrage_opportunity_evaluated: 0,
  arbitrage_quotes_fetched: 0,
  arbitrage_quotes_succeeded_cycles: 0,
  hybrid_detection_failure: 0,
  subgraph_lag_detected: 0,
  memory_stats: 0,
  liquidation_dust_filtered: 0,
  critical_errors: 0,
  flash_loan_route_selected: 0,
  oracle_untrusted_critical: 0,
  price_oracle_stale_price: 0,
  memory_ceiling_hit: 0,
  memory_warning: 0,
  txs_sent: 0,
};

let arbitrageQuotesSucceededTotal = 0;

const dynamicFloors = [];
const dustTimestampsByAccount = new Map();
let dustBurstViolations = 0;
let firstTs;
let lastTs;
let parseErrors = 0;

function recordTime(iso) {
  if (iso === undefined) return;
  if (firstTs === undefined) firstTs = iso;
  lastTs = iso;
}

function trackDustDedupe(account, timeMs) {
  if (account === undefined || timeMs === undefined) return;
  const key = String(account).toLowerCase();
  const last = dustTimestampsByAccount.get(key);
  if (last !== undefined && timeMs - last < dustDedupeWindowMs) {
    dustBurstViolations += 1;
  }
  dustTimestampsByAccount.set(key, timeMs);
}

for (const rawLine of readLogLines(logPath)) {
  const line = rawLine.trim();
  if (!line) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    parseErrors += 1;
    continue;
  }
  recordTime(row.time);
  const msg = row.msg;
  const timeMs = row.time ? Date.parse(row.time) : undefined;

  if (row.level === 50) counts.critical_errors += 1;

  switch (msg) {
    case "liquidation_evaluated":
      counts.liquidation_evaluated += 1;
      if (typeof row.dynamicFloor === "number") dynamicFloors.push(row.dynamicFloor);
      break;
    case "arbitrage_opportunity_evaluated":
      counts.arbitrage_opportunity_evaluated += 1;
      break;
    case "arbitrage_quotes_fetched":
      counts.arbitrage_quotes_fetched += 1;
      if (Number(row.quotesSucceeded) > 0) {
        counts.arbitrage_quotes_succeeded_cycles += 1;
        arbitrageQuotesSucceededTotal += Number(row.quotesSucceeded);
      }
      break;
    case "hybrid_detection_failure":
      counts.hybrid_detection_failure += 1;
      break;
    case "subgraph_lag_detected":
      counts.subgraph_lag_detected += 1;
      break;
    case "memory_stats":
      counts.memory_stats += 1;
      break;
    case "liquidation_dust_filtered":
      counts.liquidation_dust_filtered += 1;
      trackDustDedupe(row.account, timeMs);
      break;
    case "flash_loan_route_selected":
      counts.flash_loan_route_selected += 1;
      break;
    case "price_oracle_untrusted_critical":
      counts.oracle_untrusted_critical += 1;
      break;
    case "price_oracle_stale_price":
      counts.price_oracle_stale_price += 1;
      break;
    case "memory_ceiling_hit":
      counts.memory_ceiling_hit += 1;
      break;
    case "memory_warning":
      counts.memory_warning += 1;
      break;
    default:
      if (msg === "transaction_sent" || msg === "liquidation_executed" || row.sent === 1) {
        counts.txs_sent += 1;
      }
      break;
  }
}

let logSizeBytes = 0;
try {
  logSizeBytes = statSync(logPath).size;
} catch {
  console.error(JSON.stringify({ error: "log_not_found", logPath }, null, 2));
  process.exit(1);
}

const dynamicFloorSample = dynamicFloors.slice(0, 5);
const dynamicFloorMin = dynamicFloors.length ? Math.min(...dynamicFloors) : null;
const dynamicFloorMax = dynamicFloors.length ? Math.max(...dynamicFloors) : null;
const dynamicFloorMedian = dynamicFloors.length
  ? dynamicFloors.slice().sort((a, b) => a - b)[Math.floor(dynamicFloors.length / 2)]
  : null;

const metrics = [
  {
    id: 1,
    name: "liquidation_evaluated",
    pass: counts.liquidation_evaluated >= 50,
    detail: `${counts.liquidation_evaluated} events (need >=50 for dynamicFloor sanity)`,
    dynamicFloorMin,
    dynamicFloorMedian,
    dynamicFloorMax,
    dynamicFloorSample,
  },
  {
    id: 2,
    name: "arbitrage_opportunity_evaluated",
    pass: counts.arbitrage_opportunity_evaluated > 0,
    detail: `${counts.arbitrage_opportunity_evaluated} evaluations`,
  },
  {
    id: 6,
    name: "arbitrage_quotes_fetched",
    pass: counts.arbitrage_quotes_succeeded_cycles > 0,
    detail: `${counts.arbitrage_quotes_fetched} cycles, ${arbitrageQuotesSucceededTotal} successful quotes`,
  },
  {
    id: 7,
    name: "hybrid_detection_failure",
    pass: counts.hybrid_detection_failure === 0,
    detail: `${counts.hybrid_detection_failure} failures`,
  },
  {
    id: 3,
    name: "dust_log_deduped",
    pass: dustBurstViolations === 0,
    detail: `${counts.liquidation_dust_filtered} dust logs, ${dustBurstViolations} bursts inside ${dustDedupeWindowMs}ms window`,
  },
  {
    id: 4,
    name: "memory_stats",
    pass: counts.memory_stats > 0 && counts.memory_ceiling_hit === 0,
    detail: `${counts.memory_stats} samples, ceiling_hits=${counts.memory_ceiling_hit}, warnings=${counts.memory_warning}`,
  },
  {
    id: 5,
    name: "log_size_under_25mb",
    pass: logSizeBytes <= maxLogBytes,
    detail: `${(logSizeBytes / 1024 / 1024).toFixed(2)} MB`,
  },
];

const audit = {
  logPath,
  window: { firstTs, lastTs },
  logSizeBytes,
  parseErrors,
  counts,
  successMetrics: metrics,
  allPass: metrics.every((m) => m.pass) && counts.critical_errors === 0 && counts.flash_loan_route_selected === 0,
  notes: [
    "flash_loan_route_selected should stay 0 during shadow validation (no preview storm)",
    "critical_errors (level 50) should stay 0",
  ],
};

console.log(JSON.stringify(audit, null, 2));
