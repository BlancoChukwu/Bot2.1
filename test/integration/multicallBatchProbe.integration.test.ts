import "dotenv/config";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { describe, expect, it } from "vitest";
import { getChainConfig } from "../../src/config/chains";
import { BoundedWatchlist } from "../../src/monitors/boundedWatchlist";
import { EventDrivenWatchlist } from "../../src/monitors/eventDrivenWatchlist";
import { sweepHealthFactors } from "../../src/monitors/healthFactorSweep";
import { createBlockCursor } from "../../src/utils/blockCursor";

const TARGET_MS = 400;
const rpcUrl = process.env.RPC_URL ?? process.env.EXECUTION_RPC_URL_PRIMARY;
const describeLive = rpcUrl === undefined || rpcUrl.trim() === "" ? describe.skip : describe;
const runPerfBenchmark = process.env.RUN_PERF_BENCHMARKS === "1";

async function buildProbeWatchlist(client: PublicClient): Promise<readonly Address[]> {
  const pool = getChainConfig("base").aave.pool;
  const watchlist = new BoundedWatchlist();
  const cursor = await createBlockCursor("base");
  const eventWatchlist = new EventDrivenWatchlist({
    chain: "base",
    poolAddress: pool,
    readClient: client,
    watchlist,
    cursor,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    coldStartLookbackBlocks: 50_000n,
    gapChunkBlocks: 2_000n,
  });
  await eventWatchlist.coldStartFromLogs(50_000n);
  return watchlist.addresses().slice(0, 500) as Address[];
}

describeLive("multicall batch probe (Base live RPC)", () => {
  it("sweeps up to 500 borrowers without error (correctness)", async () => {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl!) }) as unknown as PublicClient;
    const addresses = await buildProbeWatchlist(client);
    expect(addresses.length).toBeGreaterThan(0);

    const liquidatable = await sweepHealthFactors(addresses, {
      client,
      poolAddress: getChainConfig("base").aave.pool,
      batchSize: 250,
      minDebtBase: 0n,
    });
    expect(Array.isArray(liquidatable)).toBe(true);
  }, 300_000);

  const describePerf = runPerfBenchmark ? it : it.skip;
  describePerf("reports round-trip latency for batch sizes (benchmark, non-blocking)", async () => {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl!) }) as unknown as PublicClient;
    const addresses = await buildProbeWatchlist(client);
    const batchSizes = [500, 250] as const;
    const observations: Array<{ batchSize: number; elapsedMs: number; underTarget: boolean }> = [];

    for (const batchSize of batchSizes) {
      const startedAt = Date.now();
      await sweepHealthFactors(addresses, {
        client,
        poolAddress: getChainConfig("base").aave.pool,
        batchSize,
        minDebtBase: 0n,
      });
      const elapsedMs = Date.now() - startedAt;
      observations.push({ batchSize, elapsedMs, underTarget: elapsedMs < TARGET_MS });
    }

    // eslint-disable-next-line no-console
    console.info("multicall_batch_probe_benchmark", {
      rpcHost: new URL(rpcUrl!).host,
      borrowerCount: addresses.length,
      targetMs: TARGET_MS,
      observations,
    });

    const anyUnderTarget = observations.some((row) => row.underTarget);
    if (!anyUnderTarget) {
      // Report-only: do not fail CI on shared/public RPC latency.
      // eslint-disable-next-line no-console
      console.warn(
        "multicall_batch_probe_benchmark: no batch size met target; use dedicated RPC and RUN_PERF_BENCHMARKS=1 for tuning",
      );
    }
    expect(observations.length).toBe(batchSizes.length);
  }, 300_000);
});
