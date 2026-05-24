import { describe, expect, it, vi } from "vitest";
import { createDebouncedBlockRescan } from "../../src/monitors/borrowerWatchlistRescanner";

describe("borrowerWatchlistRescanner", () => {
  it("debounces block-triggered rescans", () => {
    vi.useFakeTimers();
    const trigger = vi.fn();
    const onBlock = createDebouncedBlockRescan(trigger, 2_000);

    onBlock(100n);
    onBlock(101n);
    expect(trigger).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith("block", 101n);
    vi.useRealTimers();
  });
});
