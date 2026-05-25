import { describe, expect, it, vi } from "vitest";
import { StalenessGuard } from "../../src/monitors/stalenessGuard";

describe("StalenessGuard", () => {
  it("returns fresh immediately after record", () => {
    const guard = new StalenessGuard(60_000);
    guard.record();
    expect(guard.check()).toBe("fresh");
  });

  it("returns critical after max stale elapsed", () => {
    vi.useFakeTimers();
    const guard = new StalenessGuard(1_000);
    guard.record();
    vi.advanceTimersByTime(4_000);
    expect(guard.check()).toBe("critical");
    vi.useRealTimers();
  });
});
