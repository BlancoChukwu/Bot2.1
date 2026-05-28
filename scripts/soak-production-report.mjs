#!/usr/bin/env node
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const argPath = process.argv[2];
const logDir = join(process.cwd(), "logs");
const logPath = argPath
  ? resolve(argPath)
  : (() => {
    const prod = readdirSync(logDir)
      .filter((name) => name.startsWith("production-") && name.endsWith(".log"))
      .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    return prod ? join(logDir, prod.name) : join(logDir, "production-20260527-013905.log");
  })();

const nearAccounts = [
  "0xf109945302561dcbf6bede6a33f36602ae9537c0",
  "0xa7ac810c71781482427ebd7d98255acb0e0375d6",
  "0xc4d36f950cdb76dbc83717087775ff3303c6eeb7",
  "0x675c8697949e0cc6269e8625d805a2749fad6707",
  "0x8b81420441ac3933c58d1190c8499c2f89eb1263",
  "0x2e09f38c7d8b3b89b984d77f1a109f44afc79950",
];

const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
function parseRow(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
const firstRow = parseRow(lines[0] ?? "");
const lastRow = parseRow(lines[lines.length - 1] ?? "");
const firstTs = firstRow?.time;
const lastTs = lastRow?.time;
let minTs;
let maxTs;
for (const line of lines) {
  const row = parseRow(line);
  if (row?.time === undefined) continue;
  const ms = Date.parse(row.time);
  if (!Number.isFinite(ms)) continue;
  minTs = minTs === undefined ? ms : Math.min(minTs, ms);
  maxTs = maxTs === undefined ? ms : Math.max(maxTs, ms);
}
const durationMin = minTs !== undefined && maxTs !== undefined
  ? (maxTs - minTs) / 60_000
  : 0;

const hfByAccount = new Map();
const gates = {
  pipeline_cycle_diagnostics: 0,
  liquidation_evaluated: 0,
  liquidation_evaluated_pass: 0,
  arbitrage_quotes_fetched: 0,
  arbitrage_quotes_zero: 0,
  txs_sent: 0,
  near_liq_hf_trend: 0,
};
const profitableFailedSend = [];

for (const line of lines) {
  const row = parseRow(line);
  if (row === undefined) {
    continue;
  }
  const account = String(row.account ?? "").toLowerCase();
  if (nearAccounts.includes(account)) {
    if (row.msg === "liquidation_evaluated" || row.msg === "near_liq_hf_trend") {
      const prev = hfByAccount.get(account) ?? { first: undefined, last: undefined, samples: 0 };
      let hf = Number(row.healthFactor ?? row.hf);
      if (hf > 100) {
        hf /= 1e18;
      }
      if (Number.isFinite(hf)) {
        if (prev.first === undefined) prev.first = hf;
        prev.last = hf;
        prev.samples += 1;
        hfByAccount.set(account, prev);
      }
    }
  }
  switch (row.msg) {
    case "pipeline_cycle_diagnostics":
      gates.pipeline_cycle_diagnostics += 1;
      break;
    case "liquidation_evaluated":
      gates.liquidation_evaluated += 1;
      if (row.pass === true) gates.liquidation_evaluated_pass += 1;
      if (row.pass === true && row.stage?.includes("profit")) {
        profitableFailedSend.push({ account: row.account, stage: row.stage, time: row.time });
      }
      break;
    case "arbitrage_quotes_fetched":
      gates.arbitrage_quotes_fetched += 1;
      if (Number(row.quotesSucceeded) === 0) gates.arbitrage_quotes_zero += 1;
      break;
    case "near_liq_hf_trend":
      gates.near_liq_hf_trend += 1;
      break;
    default:
      if (row.msg === "transaction_sent" || row.msg === "liquidation_executed") {
        gates.txs_sent += 1;
      }
      break;
  }
}

const hfDeltas = [...hfByAccount.entries()].map(([account, stats]) => ({
  account,
  firstHf: stats.first,
  lastHf: stats.last,
  delta: stats.first !== undefined && stats.last !== undefined ? stats.last - stats.first : null,
  samples: stats.samples,
}));

console.log(JSON.stringify({
  logPath,
  durationMin: Number(durationMin.toFixed(1)),
  firstTs,
  lastTs,
  hfDeltas,
  successGateTable: gates,
  profitableFailedSendCount: profitableFailedSend.length,
  profitableFailedSendSample: profitableFailedSend.slice(0, 5),
}, null, 2));
