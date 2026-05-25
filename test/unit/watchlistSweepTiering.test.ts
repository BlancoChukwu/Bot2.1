import { describe, expect, it, vi } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { getChainConfig } from "../../src/config/chains";
import { BoundedWatchlist } from "../../src/monitors/boundedWatchlist";
import { filterAddressesForSweep } from "../../src/monitors/healthFactorSweep";
import { WatchlistCoordinator } from "../../src/monitors/watchlistCoordinator";

const WAD = 1_000_000_000_000_000_000n;
const PRE_LIQ = 1_150_000_000_000_000_000n;

describe("filterAddressesForSweep tiering", () => {
  it("includes unknown HF and HF below 1.15 every block", () => {
    const watchlist = new BoundedWatchlist();
    watchlist.add("0x0000000000000000000000000000000000000001", 100n);
    watchlist.add("0x0000000000000000000000000000000000000002", 100n);
    watchlist.updateHealthFactor("0x0000000000000000000000000000000000000002", WAD);

    const targets = filterAddressesForSweep(watchlist, 101n, 100n);
    expect(targets).toHaveLength(2);
  });

  it("skips HF >= 1.15 except on low-tier block boundary", () => {
    const watchlist = new BoundedWatchlist();
    watchlist.add("0x0000000000000000000000000000000000000001", 100n);
    watchlist.updateHealthFactor("0x0000000000000000000000000000000000000001", PRE_LIQ);

    expect(filterAddressesForSweep(watchlist, 101n, 100n)).toHaveLength(0);
    expect(filterAddressesForSweep(watchlist, 200n, 100n)).toHaveLength(1);
  });
});

describe("WatchlistCoordinator.sweepAndRefresh", () => {
  it("records staleness after sweep even when tier yields zero targets", async () => {
    const registry = createChainRegistry({
      chains: [{
        chain: "base",
        rpcUrl: "https://base.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://subgraph.example",
      }],
    });

    const coordinator = new WatchlistCoordinator({
      chain: "base",
      protocol: {
        listBorrowerAddresses: async () => [],
        getLiquidatablePositions: async () => [],
      },
      registry,
      readClient: {
        getBlockNumber: async () => 200n,
      } as never,
      poolAddress: getChainConfig("base").aave.pool,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      minDebtBase: 0n,
      lowTierEveryBlocks: 100n,
    });
    coordinator.watchlist.add("0x0000000000000000000000000000000000000001", 100n);
    coordinator.watchlist.updateHealthFactor(
      "0x0000000000000000000000000000000000000001",
      PRE_LIQ,
    );
    (coordinator as unknown as { started: boolean }).started = true;

    const recordSpy = vi.spyOn(coordinator.stalenessGuard, "record");
    await coordinator.sweepAndRefresh("base", 101n);

    expect(recordSpy).toHaveBeenCalled();
    expect(coordinator.stalenessGuard.check()).toBe("fresh");
  });
});
