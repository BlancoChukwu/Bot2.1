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

describeLive("multicall batch probe (Base live RPC)", () => {
  it("sweeps up to 500 borrowers under 400ms at 250 or 500 batch", async () => {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl!) }) as unknown as PublicClient;
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
    const addresses = watchlist.addresses().slice(0, 500) as Address[];
    expect(addresses.length).toBeGreaterThan(0);

    const batchSizes = [500, 250] as const;
    let passed = false;
    for (const batchSize of batchSizes) {
      const startedAt = Date.now();
      await sweepHealthFactors(addresses as Address[], {
        client,
        poolAddress: pool,
        batchSize,
        minDebtBase: 0n,
      });
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < TARGET_MS) {
        passed = true;
        break;
      }
    }
    expect(passed).toBe(true);
  }, 300_000);
});
