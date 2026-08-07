/**
 * Debt-size distribution for accounts that cleared HF < 1.05 this session.
 * Uses log evidence only — does not change profitability floors.
 *
 * Usage: node scripts/audit-near-liq-debt-distribution.mjs <logPath> [--json]
 */
import { readFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { resolve } from "node:path";

const NEAR_LIQ_HF = 1.05;
const MAX_BYTES = 64 * 1024 * 1024;
const logPath = resolve(process.argv[2] ?? "");
const jsonOut = process.argv.includes("--json");

if (!logPath) {
  console.error("usage: node scripts/audit-near-liq-debt-distribution.mjs <logPath> [--json]");
  process.exit(2);
}

function readLogLines(path) {
  const st = statSync(path);
  let buffer;
  if (st.size > MAX_BYTES) {
    const fd = openSync(path, "r");
    try {
      buffer = Buffer.alloc(MAX_BYTES);
      readSync(fd, buffer, 0, MAX_BYTES, st.size - MAX_BYTES);
    } finally {
      closeSync(fd);
    }
  } else {
    buffer = readFileSync(path);
  }
  const encoding = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? "utf16le"
    : "utf8";
  const lines = buffer.toString(encoding).split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (st.size > MAX_BYTES && lines.length > 1) {
    lines.shift();
  }
  return { lines, truncated: st.size > MAX_BYTES, logSizeBytes: st.size };
}

function bucketLabel(debtUsd) {
  if (!(debtUsd > 0)) return "unknown_or_zero";
  if (debtUsd < 5) return "lt_5";
  if (debtUsd < 30) return "5_to_30";
  if (debtUsd < 100) return "30_to_100";
  if (debtUsd < 500) return "100_to_500";
  if (debtUsd < 2000) return "500_to_2000";
  return "gte_2000";
}

function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const { lines, truncated, logSizeBytes } = readLogLines(logPath);

/** @type {Map<string, { minHf: number, lastHf: number }>} */
const nearLiq = new Map();
/** @type {Map<string, { debtUsd: number, samples: number }>} */
const debtByAccount = new Map();

for (const raw of lines) {
  let row;
  try {
    row = JSON.parse(raw.trim());
  } catch {
    continue;
  }
  const msg = row.msg;
  const account = typeof row.account === "string" ? row.account.toLowerCase() : undefined;
  if (account === undefined) continue;

  if (msg === "event_purity_liquidatable_candidate" && typeof row.healthFactor === "number") {
    const hf = row.healthFactor;
    if (hf < NEAR_LIQ_HF) {
      const cur = nearLiq.get(account) ?? { minHf: hf, lastHf: hf };
      cur.minHf = Math.min(cur.minHf, hf);
      cur.lastHf = hf;
      nearLiq.set(account, cur);
    }
  }

  if (msg !== "liquidation_evaluated") {
    continue;
  }

  const hf = typeof row.hfFloat === "number"
    ? row.hfFloat
    : (typeof row.healthFactor === "string" || typeof row.healthFactor === "number"
      ? Number(row.healthFactor) / (String(row.healthFactor).length > 12 ? 1e18 : 1)
      : undefined);
  if (typeof hf === "number" && Number.isFinite(hf) && hf < NEAR_LIQ_HF) {
    const cur = nearLiq.get(account) ?? { minHf: hf, lastHf: hf };
    cur.minHf = Math.min(cur.minHf, hf);
    cur.lastHf = hf;
    nearLiq.set(account, cur);
  }

  if (
    typeof row.debtUsd === "number"
    && Number.isFinite(row.debtUsd)
    && row.stage !== "pipeline_cycle_sample"
  ) {
    const cur = debtByAccount.get(account) ?? { debtUsd: row.debtUsd, samples: 0 };
    cur.debtUsd = row.debtUsd;
    cur.samples += 1;
    debtByAccount.set(account, cur);
  }
}

const nearLiqAccounts = [...nearLiq.entries()].map(([account, row]) => {
  const debt = debtByAccount.get(account);
  return {
    account,
    minHf: row.minHf,
    lastHf: row.lastHf,
    ...(debt === undefined ? { debtSamples: 0 } : { debtUsd: debt.debtUsd, debtSamples: debt.samples }),
  };
});
const withDebt = nearLiqAccounts.filter((row) => typeof row.debtUsd === "number");
const debts = withDebt.map((row) => /** @type {number} */ (row.debtUsd)).sort((a, b) => a - b);
const buckets = {
  lt_5: 0,
  "5_to_30": 0,
  "30_to_100": 0,
  "100_to_500": 0,
  "500_to_2000": 0,
  gte_2000: 0,
  unknown_or_zero: 0,
};
for (const row of nearLiqAccounts) {
  buckets[bucketLabel(row.debtUsd ?? 0)] += 1;
}

const report = {
  logPath,
  logSizeMb: Number((logSizeBytes / 1024 / 1024).toFixed(2)),
  truncated,
  nearLiqHfThreshold: NEAR_LIQ_HF,
  nearLiqAccounts: nearLiqAccounts.length,
  withDebtUsd: withDebt.length,
  missingDebtUsd: nearLiqAccounts.length - withDebt.length,
  debtUsd: debts.length === 0
    ? undefined
    : {
      min: debts[0],
      p50: percentile(debts, 50),
      p90: percentile(debts, 90),
      p99: percentile(debts, 99),
      max: debts[debts.length - 1],
      mean: debts.reduce((a, b) => a + b, 0) / debts.length,
    },
  buckets,
  topByDebt: [...withDebt]
    .sort((a, b) => (b.debtUsd ?? 0) - (a.debtUsd ?? 0))
    .slice(0, 15)
    .map((row) => ({
      account: row.account,
      debtUsd: row.debtUsd,
      minHf: row.minHf,
      lastHf: row.lastHf,
    })),
  sub5Share: nearLiqAccounts.length === 0
    ? undefined
    : Number((buckets.lt_5 / nearLiqAccounts.length).toFixed(4)),
};

if (jsonOut) {
  console.log(JSON.stringify(report));
  process.exit(0);
}

console.log("── Near-liq debt distribution (HF < 1.05) ──");
console.log(`  Log: ${report.logPath} (${report.logSizeMb} MB${truncated ? ", truncated to last 64MB" : ""})`);
console.log(`  Near-liq accounts: ${report.nearLiqAccounts} (with debtUsd=${report.withDebtUsd}, missing=${report.missingDebtUsd})`);
if (report.debtUsd !== undefined) {
  const d = report.debtUsd;
  console.log(
    `  debtUsd: min=${d.min.toFixed(4)} p50=${d.p50.toFixed(4)} p90=${d.p90.toFixed(4)}`
    + ` p99=${d.p99.toFixed(4)} max=${d.max.toFixed(4)} mean=${d.mean.toFixed(4)}`,
  );
}
console.log(
  `  Buckets: <$5=${buckets.lt_5} $5–30=${buckets["5_to_30"]} $30–100=${buckets["30_to_100"]}`
  + ` $100–500=${buckets["100_to_500"]} $500–2k=${buckets["500_to_2000"]} ≥$2k=${buckets.gte_2000}`
  + ` unknown=${buckets.unknown_or_zero}`,
);
if (report.sub5Share !== undefined) {
  console.log(`  Sub-$5 share: ${(report.sub5Share * 100).toFixed(1)}% of near-liq accounts`);
}
if (report.topByDebt.length > 0) {
  console.log("  Top by debtUsd:");
  for (const row of report.topByDebt) {
    console.log(
      `    ${row.account} debtUsd=${row.debtUsd?.toFixed(4)} minHf=${row.minHf.toFixed(6)} lastHf=${row.lastHf.toFixed(6)}`,
    );
  }
}
