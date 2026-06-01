#!/usr/bin/env node
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { join } from "node:path";

config({ path: join(process.cwd(), ".env") });

function gateScaleFactor() {
  const budget = (process.env.RPC_BUDGET_MODE ?? "").trim().toLowerCase();
  if (budget === "1" || budget === "true" || budget === "yes" || budget === "on") {
    const raw = process.env.GATE_SCALE_FACTOR?.trim();
    const parsed = raw ? Number(raw) : 2;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
  }
  const raw = process.env.GATE_SCALE_FACTOR?.trim();
  const parsed = raw ? Number(raw) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function scaled(base) {
  return base * gateScaleFactor();
}

const reportPath = process.argv[2] ?? join(process.cwd(), ".runtime", "rpc-benchmark.json");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const scale = gateScaleFactor();
const wsP95Limit = scaled(50);
const failures = [];

for (const target of report.targets ?? []) {
  const ws = target.newHeadsWsLatency;
  if (ws?.p95_ms !== undefined && ws.p95_ms >= wsP95Limit) {
    failures.push({
      target: target.target,
      check: "newHeadsWsLatency.p95_ms",
      value: ws.p95_ms,
      limit: wsP95Limit,
    });
  }
  if (ws?.failed === true) {
    failures.push({ target: target.target, check: "newHeadsWsLatency", error: ws.error });
  }
  const eth = target.ethCallRtt;
  if (eth?.failed === true) {
    failures.push({ target: target.target, check: "ethCallRtt", error: eth.error });
  }
}

const result = {
  reportPath,
  gateScaleFactor: scale,
  wsP95LimitMs: wsP95Limit,
  passed: failures.length === 0,
  failures,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 2);
