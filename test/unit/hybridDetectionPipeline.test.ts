import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import {
  HybridDetectionPipeline,
  type BorrowerSnapshotProvider,
  type DetectionEventSource,
} from "../../src/monitors/hybridDetectionPipeline";
import type { BorrowerSnapshot } from "../../src/monitors/reserveAwareBorrowerCache";

const account = "0x0000000000000000000000000000000000000001";
const registry = createChainRegistry({
  chains: [{
    chain: "optimism",
    rpcUrl: "https://optimism.example",
    fallbackRpcUrls: [],
    aaveSubgraphUrl: "https://subgraph.example",
  }],
});

const snapshot: BorrowerSnapshot = {
  chain: "optimism",
  account,
  healthFactor: 900_000_000_000_000_000n,
  updatedAtMs: 1_000,
  reserves: [],
};

describe("HybridDetectionPipeline", () => {
  it("refreshes hot borrowers when reserve events arrive", async () => {
    let onReserveUpdated: ((event: { readonly chain: "optimism"; readonly reserve: `0x${string}` }) => void) | undefined;
    const eventSource: DetectionEventSource = {
      start: (handlers) => {
        onReserveUpdated = handlers.onReserveUpdated;
        return () => undefined;
      },
    };
    const provider: BorrowerSnapshotProvider = {
      getBorrowersForReserve: async () => [account],
      refreshBorrowers: async (_chain, accounts) => accounts.map((borrower) => ({ ...snapshot, account: borrower })),
      pollBorrowers: async () => [],
    };
    const pipeline = new HybridDetectionPipeline({
      registry,
      eventSource,
      provider,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    await pipeline.start();
    onReserveUpdated?.({
      chain: "optimism",
      reserve: "0x0000000000000000000000000000000000000002",
    });
    await pipeline.drain();

    expect(pipeline.cache.get("optimism", account)).toMatchObject({ account });
    pipeline.stop();
  });

  it("uses fallback polling to seed the reserve-aware cache", async () => {
    const provider: BorrowerSnapshotProvider = {
      getBorrowersForReserve: async () => [],
      refreshBorrowers: async () => [],
      pollBorrowers: async () => [snapshot],
    };
    const pipeline = new HybridDetectionPipeline({
      registry,
      eventSource: { start: () => () => undefined },
      provider,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    await pipeline.pollFallback("optimism");

    expect(pipeline.cache.listAccounts("optimism")).toEqual([account]);
  });

  it("opens the chain RPC circuit breaker after event source failures", async () => {
    const pipeline = new HybridDetectionPipeline({
      registry,
      eventSource: {
        start: (handlers) => {
          handlers.onError("optimism", new Error("websocket down"));
          return () => undefined;
        },
      },
      provider: {
        getBorrowersForReserve: async () => [],
        refreshBorrowers: async () => [],
        pollBorrowers: async () => [],
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      failureThreshold: 1,
    });

    await pipeline.start();

    expect(pipeline.getCircuitBreakerState("optimism", "rpc").status).toBe("open");
  });
});
