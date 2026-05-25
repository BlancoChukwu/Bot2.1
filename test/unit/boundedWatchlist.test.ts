import { describe, expect, it } from "vitest";
import { BoundedWatchlist } from "../../src/monitors/boundedWatchlist";

describe("BoundedWatchlist", () => {
  it("tracks addresses and updates last seen block", () => {
    const watchlist = new BoundedWatchlist();
    watchlist.add("0x0000000000000000000000000000000000000001", 100n);
    watchlist.add("0x0000000000000000000000000000000000000002", 200n);
    expect(watchlist.size()).toBe(2);
    expect(watchlist.addresses()).toContain("0x0000000000000000000000000000000000000001");
  });

  it("evicts entries older than stale block window when at capacity", () => {
    const watchlist = new BoundedWatchlist(2, 10n);
    watchlist.add("0x0000000000000000000000000000000000000001", 1n);
    watchlist.add("0x0000000000000000000000000000000000000002", 2n);
    watchlist.add("0x0000000000000000000000000000000000000003", 100n);
    expect(watchlist.size()).toBeLessThanOrEqual(2);
    expect(watchlist.addresses()).not.toContain("0x0000000000000000000000000000000000000001");
  });
});
