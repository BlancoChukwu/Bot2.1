import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { HybridDetectionPipeline } from "../../src/monitors/hybridDetectionPipeline";

describe("Multi-WS fallback chaos", () => {
  const pipelines: HybridDetectionPipeline[] = [];

  afterEach(async () => {
    for (const pipeline of pipelines.splice(0)) {
      pipeline.stop();
      await pipeline.drain();
    }
    vi.clearAllMocks();
  });

  it("keeps polling fallback active when websocket event source is down", async () => {
    const account = "0x0000000000000000000000000000000000000001";
    const pipeline = new HybridDetectionPipeline({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      eventSource: {
        start: (handlers) => {
          handlers.onError("optimism", new Error("all websocket endpoints unavailable"));
          return () => undefined;
        },
      },
      provider: {
        getBorrowersForReserve: async () => [],
        refreshBorrowers: async () => [],
        pollBorrowers: async () => [{
          chain: "optimism",
          account,
          healthFactor: 900_000_000_000_000_000n,
          updatedAtMs: Date.now(),
          reserves: [],
        }],
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      failureThreshold: 1,
    });
    pipelines.push(pipeline);

    await pipeline.start();
    expect(pipeline.getCircuitBreakerState("optimism", "rpc").status).toBe("open");
    await pipeline.pollFallback("optimism");

    expect(pipeline.cache.listAccounts("optimism")).toContain(account);
  });
});
