import { describe, expect, it } from "vitest";
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
  it("falls back to on-chain log seeding when subgraph listing fails", async () => {
    const readClient = {
      getBlockNumber: async () => 10_000n,
      getLogs: async () => [{
        args: {
          onBehalfOf: "0x0000000000000000000000000000000000000001",
          user: "0x0000000000000000000000000000000000000002",
        },
      }],
      multicall: async () => [{
        status: "success",
        result: [0n, 1n, 0n, 0n, 0n, 0n],
      }],
    };
    const coordinator = new WatchlistCoordinator({
      chain: "base",
      protocol: {
        listBorrowerAddresses: async () => {
          throw new Error("subgraph quota");
        },
        getLiquidatablePositions: async () => [],
      },
      registry,
      readClient: readClient as never,
      poolAddress: getChainConfig("base").aave.pool,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      minDebtBase: 0n,
      onChainColdStartLookbackBlocks: 10n,
      reserveAllowlist: [],
    });

    await (coordinator as unknown as { seedColdStart: () => Promise<void> }).seedColdStart();

    expect(coordinator.watchlist.size()).toBeGreaterThan(0);
  });
});
