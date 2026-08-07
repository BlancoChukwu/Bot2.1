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

describe("WatchlistCoordinator staleness heartbeat", () => {
  it("touchActivity and re-register keep the guard fresh", () => {
    vi.useFakeTimers();
    const coordinator = new WatchlistCoordinator({
      chain: "base",
      protocol: {
        listBorrowerAddresses: async () => [],
        getLiquidatablePositions: async () => [],
      },
      registry,
      readClient: { getBlockNumber: async () => 1n } as never,
      poolAddress: getChainConfig("base").aave.pool,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      minDebtBase: 0n,
      maxStaleMs: 1_000,
      reserveAllowlist: [],
    });

    coordinator.touchActivity();
    expect(coordinator.stalenessGuard.check()).toBe("fresh");

    const account = "0x00000000000000000000000000000000000000aa" as const;
    expect(coordinator.registerBorrowers([account])).toBe(1);
    vi.advanceTimersByTime(3_500);
    expect(coordinator.stalenessGuard.check()).toBe("critical");

    // Already-known borrower must still heartbeat (event-purity quiet markets).
    expect(coordinator.registerBorrowers([account])).toBe(0);
    expect(coordinator.stalenessGuard.check()).toBe("fresh");
    vi.useRealTimers();
  });

  it("emitHeartbeat logs structured watchlist_heartbeat", () => {
    const logger = createLogger("silent");
    const lines: string[] = [];
    const originalInfo = logger.info.bind(logger);
    logger.info = (msg: string, meta?: Record<string, unknown>) => {
      lines.push(JSON.stringify({ msg, ...meta }));
      originalInfo(msg, meta);
    };
    const coordinator = new WatchlistCoordinator({
      chain: "base",
      protocol: {
        listBorrowerAddresses: async () => [],
        getLiquidatablePositions: async () => [],
      },
      registry,
      readClient: { getBlockNumber: async () => 1n } as never,
      poolAddress: getChainConfig("base").aave.pool,
      logger,
      metrics: createBotMetrics(),
      minDebtBase: 0n,
      maxStaleMs: 60_000,
      reserveAllowlist: [],
    });

    coordinator.emitHeartbeat("oracle_poll", { blockNumber: "123" });

    const heartbeat = lines.find((line) => line.includes("watchlist_heartbeat"));
    expect(heartbeat).toBeDefined();
    expect(heartbeat).toContain("oracle_poll");
    expect(heartbeat).toContain("\"staleness\":\"fresh\"");
  });
});
