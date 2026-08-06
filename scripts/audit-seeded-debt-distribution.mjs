/**
 * Debt-size distribution over the full seeded bootstrap/position cache.
 * Answers discovery bias vs empty near-liq market — does not change floors.
 *
 * Usage:
 *   node scripts/audit-seeded-debt-distribution.mjs [.cache/bootstrap-snapshot-base.json] [--json]
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_CACHE = ".cache/bootstrap-snapshot-base.json";
const WAD = 1e18;
const BASE_USD_SCALE = 1e8;

const args = process.argv.slice(2).filter((a) => a !== "--json");
const jsonOut = process.argv.includes("--json");
const cachePath = resolve(args[0] ?? DEFAULT_CACHE);

if (!existsSync(cachePath)) {
  console.error(`cache not found: ${cachePath}`);
  console.error("hint: on the VM this is usually .cache/bootstrap-snapshot-base.json");
  process.exit(2);
}

function bucketLabel(debtUsd) {
  if (!(debtUsd > 0)) return "zero_or_missing";
  if (debtUsd < 5) return "lt_5";
  if (debtUsd < 30) return "5_to_30";
  if (debtUsd < 100) return "30_to_100";
  if (debtUsd < 500) return "100_to_500";
  if (debtUsd < 2000) return "500_to_2000";
  return "gte_2000";
}

function hfBucket(hf) {
  if (!(hf >= 0) || !Number.isFinite(hf)) return "unknown_hf";
  if (hf < 1) return "liquidatable_hf_lt_1";
  if (hf < 1.05) return "near_liq_hf_lt_1_05";
  if (hf < 1.2) return "watch_hf_lt_1_2";
  return "healthy_hf_gte_1_2";
}

function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const raw = JSON.parse(readFileSync(cachePath, "utf8"));
const positions = Array.isArray(raw) ? raw : (raw.positions ?? []);
const st = statSync(cachePath);

const debtBuckets = {
  lt_5: 0,
  "5_to_30": 0,
  "30_to_100": 0,
  "100_to_500": 0,
  "500_to_2000": 0,
  gte_2000: 0,
  zero_or_missing: 0,
};
const hfBuckets = {
  liquidatable_hf_lt_1: 0,
  near_liq_hf_lt_1_05: 0,
  watch_hf_lt_1_2: 0,
  healthy_hf_gte_1_2: 0,
  unknown_hf: 0,
};

/** Cross: HF band × debt bucket counts */
const cross = {};
const rows = [];
let withDebt = 0;
let actionable30 = 0;

for (const pos of positions) {
  const debtUsd = Number(pos.totalDebtBase ?? 0) / BASE_USD_SCALE;
  const hfRaw = pos.healthFactorWad ?? pos.healthFactor;
  const hf = hfRaw === undefined || hfRaw === null
    ? Number.NaN
    : Number(hfRaw) / (String(hfRaw).length > 12 ? WAD : 1);
  const dBucket = bucketLabel(debtUsd);
  const hBucket = hfBucket(hf);
  debtBuckets[dBucket] += 1;
  hfBuckets[hBucket] += 1;
  const crossKey = `${hBucket}|${dBucket}`;
  cross[crossKey] = (cross[crossKey] ?? 0) + 1;
  if (debtUsd > 0) {
    withDebt += 1;
    rows.push({
      account: String(pos.account ?? "").toLowerCase(),
      debtUsd,
      hf: Number.isFinite(hf) ? hf : undefined,
    });
    if (debtUsd >= 30) {
      actionable30 += 1;
    }
  }
}

const debts = rows.map((r) => r.debtUsd).sort((a, b) => a - b);
const sub5 = debtBuckets.lt_5;
const report = {
  cachePath,
  cacheSizeMb: Number((st.size / 1024 / 1024).toFixed(2)),
  chain: raw.chain,
  discoverySource: raw.discoverySource,
  savedAtMs: raw.savedAtMs,
  savedAt: raw.savedAtMs ? new Date(raw.savedAtMs).toISOString() : undefined,
  blockNumber: raw.blockNumber,
  usersSeeded: raw.usersSeeded ?? positions.length,
  positions: positions.length,
  withDebt,
  zeroDebt: debtBuckets.zero_or_missing,
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
  debtBuckets,
  hfBuckets,
  /** Share of positions with debt that are still dust (&lt;$5). */
  sub5ShareOfWithDebt: withDebt === 0 ? undefined : Number((sub5 / withDebt).toFixed(4)),
  /** Positions with debt ≥ $30 (above current hard floor). */
  debtGte30: actionable30,
  debtGte30ShareOfWithDebt: withDebt === 0 ? undefined : Number((actionable30 / withDebt).toFixed(4)),
  crossHfDebt: cross,
  topByDebt: [...rows].sort((a, b) => b.debtUsd - a.debtUsd).slice(0, 20),
  liquidatableWithDebtGte30: rows.filter((r) => (r.hf ?? 99) < 1 && r.debtUsd >= 30).length,
  nearLiqWithDebtGte30: rows.filter((r) => {
    const hf = r.hf ?? 99;
    return hf >= 1 && hf < 1.05 && r.debtUsd >= 30;
  }).length,
};

if (jsonOut) {
  console.log(JSON.stringify(report));
  process.exit(0);
}

console.log("── Seeded cache debt distribution ──");
console.log(`  Cache: ${report.cachePath} (${report.cacheSizeMb} MB)`);
if (report.discoverySource !== undefined) {
  console.log(`  Source: ${report.discoverySource} block=${report.blockNumber ?? "?"} saved=${report.savedAt ?? "?"}`);
}
console.log(`  Positions: ${report.positions} (withDebt=${report.withDebt} zero=${report.zeroDebt})`);
if (report.debtUsd !== undefined) {
  const d = report.debtUsd;
  console.log(
    `  debtUsd: min=${d.min.toFixed(2)} p50=${d.p50.toFixed(2)} p90=${d.p90.toFixed(2)}`
    + ` p99=${d.p99.toFixed(2)} max=${d.max.toFixed(2)} mean=${d.mean.toFixed(2)}`,
  );
}
console.log(
  `  Debt buckets: <$5=${debtBuckets.lt_5} $5–30=${debtBuckets["5_to_30"]} $30–100=${debtBuckets["30_to_100"]}`
  + ` $100–500=${debtBuckets["100_to_500"]} $500–2k=${debtBuckets["500_to_2000"]} ≥$2k=${debtBuckets.gte_2000}`
  + ` zero=${debtBuckets.zero_or_missing}`,
);
console.log(
  `  HF bands: liq<1=${hfBuckets.liquidatable_hf_lt_1} near<1.05=${hfBuckets.near_liq_hf_lt_1_05}`
  + ` watch<1.2=${hfBuckets.watch_hf_lt_1_2} healthy≥1.2=${hfBuckets.healthy_hf_gte_1_2}`,
);
if (report.sub5ShareOfWithDebt !== undefined) {
  console.log(
    `  Sub-$5 share of withDebt: ${(report.sub5ShareOfWithDebt * 100).toFixed(1)}%`
    + ` | debt≥$30: ${report.debtGte30} (${((report.debtGte30ShareOfWithDebt ?? 0) * 100).toFixed(1)}%)`,
  );
}
console.log(
  `  Actionable cross: liquidatable∧debt≥$30=${report.liquidatableWithDebtGte30}`
  + ` nearLiq∧debt≥$30=${report.nearLiqWithDebtGte30}`,
);
if (report.topByDebt.length > 0) {
  console.log("  Top by debtUsd:");
  for (const row of report.topByDebt.slice(0, 10)) {
    const hfStr = row.hf === undefined ? "?" : row.hf.toFixed(4);
    console.log(`    ${row.account} debtUsd=${row.debtUsd.toFixed(2)} hf=${hfStr}`);
  }
}

const verdict = report.debtGte30 === 0
  ? "BOOTSTRAP_DUST_OR_EMPTY — no debt≥$30 in seeded cache"
  : report.liquidatableWithDebtGte30 + report.nearLiqWithDebtGte30 === 0
    ? "COVERAGE_OK_MARKET_QUIET — size exists but nothing near liquidation"
    : "OPPORTUNITY_SURFACE_PRESENT — size near/at liquidation exists";
console.log(`  Verdict: ${verdict}`);
