import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import {
  HybridDetectionPipeline,
  type DetectionEventHandlers,
} from "../../src/monitors/hybridDetectionPipeline";
import type { BorrowerSnapshot } from "../../src/monitors/reserveAwareBorrowerCache";

const account = "0x0000000000000000000000000000000000000001";

describe("HybridDetectionPipeline event-path integration", () => {
  it("processes event and fallback paths through the same borrower cache", async () => {
    let handlers: DetectionEventHandlers | undefined;
    const registry = createChainRegistry({
      chains: [{
        chain: "optimism",
        rpcUrl: "https://optimism.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://subgraph.example",
      }],
    });
    const snapshots: BorrowerSnapshot[] = [];
    const pipeline = new HybridDetectionPipeline({
      registry,
      eventSource: {
        start: (nextHandlers) => {
          handlers = nextHandlers;
          return () => undefined;
        },
      },
      provider: {
        getBorrowersForReserve: async () => [account],
        refreshBorrowers: async (_chain, accounts) =>
          accounts.map((borrower, index) => ({
            chain: "optimism",
            account: borrower,
            healthFactor: 900_000_000_000_000_000n,
            updatedAtMs: 1_000 + index,
            reserves: [],
          })),
        pollBorrowers: async () => snapshots,
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    await pipeline.start();
    handlers?.onReserveUpdated({
      chain: "optimism",
      reserve: "0x0000000000000000000000000000000000000002",
    });
    await pipeline.drain();
    snapshots.push({
      chain: "optimism",
      account,
      healthFactor: 850_000_000_000_000_000n,
      updatedAtMs: 2_000,
      reserves: [],
    });
    await pipeline.pollFallback("optimism");

    expect(pipeline.cache.get("optimism", account)?.updatedAtMs).toBe(2_000);
    pipeline.stop();
  });
});
