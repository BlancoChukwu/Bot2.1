import { describe, expect, it, vi } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { getChainConfig } from "../../src/config/chains";
import { WatchlistCoordinator } from "../../src/monitors/watchlistCoordinator";

const registry = createChainRegistry({
  chains: [{
    chain: "base",
    rpcUrl: "https://base.example",
    fallbackRpcUrls: [],
    aaveSubgraphUrl: "https://subgraph.example",
  }],
});

describe("WatchlistCoordinator cold start", () => {
  it("falls back to RPC log seeding when subgraph listing fails", async () => {
    const coordinator = new WatchlistCoordinator({
      chain: "base",
      protocol: {
        listBorrowerAddresses: async () => {
          throw new Error("subgraph quota");
        },
        getLiquidatablePositions: async () => [],
      },
      registry,
      readClient: {
        getBlockNumber: async () => 1_000n,
      } as never,
      poolAddress: getChainConfig("base").aave.pool,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      minDebtBase: 0n,
      coldStartLookbackBlocks: 10n,
    });
    const coldStartFromLogs = vi.fn(async () => {
      coordinator.watchlist.add("0x0000000000000000000000000000000000000001", 999n);
      coordinator.watchlist.add("0x0000000000000000000000000000000000000002", 999n);
    });
    (coordinator as unknown as { eventWatchlist: { coldStartFromLogs: typeof coldStartFromLogs } }).eventWatchlist = {
      coldStartFromLogs,
    };

    await (coordinator as unknown as { seedColdStart: () => Promise<void> }).seedColdStart();

    expect(coldStartFromLogs).toHaveBeenCalledOnce();
    expect(coordinator.watchlist.size()).toBe(2);
  });
});
