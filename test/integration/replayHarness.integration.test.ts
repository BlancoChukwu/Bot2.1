import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { ReplayHarness } from "../../src/backtesting/replayHarness";
import type { BorrowerSnapshot } from "../../src/monitors/reserveAwareBorrowerCache";

const account = "0x0000000000000000000000000000000000000001";

describe("ReplayHarness", () => {
  it("replays reserve events and materializes snapshots for backtesting", async () => {
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
      updatedAtMs: Date.now(),
      reserves: [],
    };
    const harness = new ReplayHarness({
      registry,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      events: [{
        atMs: 0,
        chain: "optimism",
        reserve: "0x0000000000000000000000000000000000000010",
      }],
      provider: {
        getBorrowersForReserve: async () => [account],
        refreshBorrowers: async () => [snapshot],
        pollBorrowers: async () => [],
      },
    });

    const snapshots = await harness.run();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.account).toBe(account);
  });
});
