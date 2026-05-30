#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

dotenv.config();

const durationMs = Number.parseInt(process.env.RPC_BENCH_DURATION_MS ?? "30000", 10);
const tickMs = Number.parseInt(process.env.RPC_BENCH_TICK_MS ?? "200", 10);
const wsSamples = Number.parseInt(process.env.RPC_BENCH_WS_SAMPLES ?? "20", 10);
const callSamples = Number.parseInt(process.env.RPC_BENCH_CALL_SAMPLES ?? "20", 10);

const defaultPool = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const poolAddress = process.env.AAVE_POOL_ADDRESS ?? defaultPool;
const benchmarkUser = process.env.RPC_BENCH_USER ?? "0x0000000000000000000000000000000000000000";
const outputPath = process.env.RPC_BENCH_OUTPUT ?? join(process.cwd(), ".runtime", "rpc-benchmark.json");

const poolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

function pct(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function median(values) {
  return pct(values, 0.5);
}

function parseCsv(input) {
  return (input ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function resolveTargets() {
  const targets = [];
  const seen = new Set();
  const add = (name, wsUrl, httpUrl, flashblocksHttpUrl) => {
    if (!name || !httpUrl) {
      return;
    }
    const key = `${name}|${wsUrl}|${httpUrl}|${flashblocksHttpUrl ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push({ name, wsUrl, httpUrl, flashblocksHttpUrl: flashblocksHttpUrl ?? httpUrl });
  };

  add(
    "alchemy",
    process.env.RPC_BENCH_ALCHEMY_WS ?? process.env.WS_RPC_URL_SECONDARY,
    process.env.RPC_BENCH_ALCHEMY_HTTP ?? process.env.EXECUTION_RPC_URL_PRIMARY,
    process.env.RPC_BENCH_ALCHEMY_FLASHBLOCKS_HTTP ?? process.env.FLASHBLOCKS_RPC_URL,
  );
  add(
    "chainstack",
    process.env.RPC_BENCH_CHAINSTACK_WS ?? process.env.WS_RPC_URL_TERTIARY,
    process.env.RPC_BENCH_CHAINSTACK_HTTP ?? parseCsv(process.env.EXECUTION_RPC_URL_FALLBACKS)[0],
    process.env.RPC_BENCH_CHAINSTACK_FLASHBLOCKS_HTTP ?? parseCsv(process.env.EXECUTION_RPC_URL_FALLBACKS)[0],
  );
  add(
    "quicknode",
    process.env.RPC_BENCH_QUICKNODE_WS ?? process.env.WS_RPC_URL_PRIMARY,
    process.env.RPC_BENCH_QUICKNODE_HTTP ?? process.env.RPC_URL,
    process.env.RPC_BENCH_QUICKNODE_FLASHBLOCKS_HTTP ?? process.env.FLASHBLOCKS_RPC_URL,
  );
  return targets;
}

async function benchmarkEthCall(httpUrl) {
  const client = createPublicClient({ chain: base, transport: http(httpUrl) });
  const durations = [];
  for (let i = 0; i < callSamples; i += 1) {
    const started = Date.now();
    await client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "getUserAccountData",
      args: [benchmarkUser],
    });
    durations.push(Date.now() - started);
  }
  return {
    samples: durations.length,
    p50_ms: median(durations),
    p95_ms: pct(durations, 0.95),
    p99_ms: pct(durations, 0.99),
  };
}

function createWsRpc(wsUrl) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("Global WebSocket is unavailable in this Node runtime"));
      return;
    }
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 1;

    ws.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data));
      if (data.id !== undefined && pending.has(data.id)) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) {
          entry.reject(new Error(String(data.error.message ?? data.error.code)));
          return;
        }
        entry.resolve(data.result);
      }
    });
    ws.addEventListener("open", () => {
      resolve({
        close: () => ws.close(),
        call: (method, params = []) => new Promise((innerResolve, innerReject) => {
          const id = seq++;
          pending.set(id, { resolve: innerResolve, reject: innerReject });
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        }),
        subscribeNewHeads: (onHead) => new Promise((innerResolve, innerReject) => {
          const id = seq++;
          pending.set(id, { resolve: innerResolve, reject: innerReject });
          const handler = (event) => {
            const data = JSON.parse(String(event.data));
            if (data.method === "eth_subscription") {
              onHead(data.params?.result);
            }
          };
          ws.addEventListener("message", handler);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "eth_subscribe", params: ["newHeads"] }));
        }),
      });
    });
    ws.addEventListener("error", (event) => {
      reject(new Error(`WebSocket connection failed: ${JSON.stringify(event)}`));
    });
  });
}

async function benchmarkNewHeadsWs(wsUrl) {
  const rpc = await createWsRpc(wsUrl);
  const samples = [];
  let startedAt = 0;
  let active = true;

  await rpc.subscribeNewHeads(() => {
    if (!active || startedAt === 0) {
      return;
    }
    samples.push(Date.now() - startedAt);
    startedAt = Date.now();
  });

  await rpc.call("eth_blockNumber", []);
  startedAt = Date.now();
  const maxWaitMs = Math.max(durationMs, wsSamples * 1_500);
  const waitStart = Date.now();
  while (samples.length < wsSamples && Date.now() - waitStart < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  active = false;
  rpc.close();
  return {
    samples: samples.length,
    p50_ms: median(samples),
    p95_ms: pct(samples, 0.95),
    p99_ms: pct(samples, 0.99),
  };
}

async function benchmarkFlashblocks(flashblocksHttpUrl) {
  const client = createPublicClient({ chain: base, transport: http(flashblocksHttpUrl) });
  const cadence = [];
  const lead = [];
  const started = Date.now();
  let lastTick = started;
  let totalTicks = 0;

  while (Date.now() - started < durationMs) {
    const tickStarted = Date.now();
    try {
      await client.getLogs({
        address: poolAddress,
        fromBlock: "pending",
        toBlock: "pending",
      });
      lead.push(Date.now() - tickStarted);
    } catch {
      // keep probing so we still measure cadence
    }
    totalTicks += 1;
    const now = Date.now();
    cadence.push(now - lastTick);
    lastTick = now;
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
  return {
    ticks: totalTicks,
    median_cadence_ms: median(cadence),
    p95_cadence_ms: pct(cadence, 0.95),
    p95_lead_ms: pct(lead, 0.95),
    p99_lead_ms: pct(lead, 0.99),
  };
}

async function benchmarkTarget(target) {
  const output = {
    target: target.name,
    ws_url: target.wsUrl,
    http_url: target.httpUrl,
    flashblocks_http_url: target.flashblocksHttpUrl,
  };

  try {
    output.newHeadsWsLatency = target.wsUrl
      ? await benchmarkNewHeadsWs(target.wsUrl)
      : { skipped: true, reason: "ws_url_missing" };
  } catch (error) {
    output.newHeadsWsLatency = { failed: true, error: String(error) };
  }

  try {
    output.ethCallRtt = await benchmarkEthCall(target.httpUrl);
  } catch (error) {
    output.ethCallRtt = { failed: true, error: String(error) };
  }

  try {
    output.flashblockStream = target.flashblocksHttpUrl
      ? await benchmarkFlashblocks(target.flashblocksHttpUrl)
      : { skipped: true, reason: "flashblocks_http_url_missing" };
  } catch (error) {
    output.flashblockStream = { failed: true, error: String(error) };
  }

  return output;
}

async function main() {
  const targets = resolveTargets();
  if (targets.length === 0) {
    throw new Error("No benchmark targets resolved. Set RPC_BENCH_* or standard RPC env vars.");
  }
  const results = [];
  for (const target of targets) {
    // Sequential per target to avoid saturating local egress.
    results.push(await benchmarkTarget(target));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    regionExpected: process.env.RPC_BENCH_REGION_EXPECTED ?? "us-east-1",
    durationMs,
    wsSamples,
    callSamples,
    tickMs,
    poolAddress,
    benchmarkUser,
    targets: results,
  };

  mkdirSync(join(process.cwd(), ".runtime"), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
