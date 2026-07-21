import { describe, expect, it } from "vitest";
import {
  buildMemoryAttributionSnapshot,
  createMemorySurvivalState,
  recordMemoryPressureEviction,
  shouldTriggerSurvivalExit,
} from "../../src/utils/memoryAttribution";

describe("memoryAttribution", () => {
  it("builds structured memory_snapshot fields", () => {
    const snapshot = buildMemoryAttributionSnapshot({
      rssWarnMb: 700,
      counters: { wsSubs: 4, inFlightRpc: 2, shadowQueueDepth: 1 },
    });
    expect(snapshot.msg).toBe("memory_snapshot");
    expect(snapshot.rssWarnMb).toBe(700);
    expect(snapshot.wsSubs).toBe(4);
    expect(snapshot.inFlightRpc).toBe(2);
    expect(snapshot.shadowQueueDepth).toBe(1);
    expect(snapshot.rssMb).toBeGreaterThan(0);
  });

  it("triggers survival after sustained high RSS with low eviction", () => {
    let state = createMemorySurvivalState();
    const config = { sustainedRssWarnMs: 1_000, minEvictionCount: 5 };
    const t0 = 1_000_000;
    state = recordMemoryPressureEviction(state, {
      evicted: 0,
      rssAboveWarn: true,
      nowMs: t0,
      config,
    });
    expect(shouldTriggerSurvivalExit(state, {
      nowMs: t0 + 500,
      config,
      consecutiveWarningThreshold: 3,
    })).toBe(false);
    expect(shouldTriggerSurvivalExit(state, {
      nowMs: t0 + 1_500,
      config,
      consecutiveWarningThreshold: 3,
    })).toBe(true);
  });

  it("resets survival state when eviction is effective", () => {
    const config = { sustainedRssWarnMs: 60_000, minEvictionCount: 5 };
    const state = recordMemoryPressureEviction(createMemorySurvivalState(), {
      evicted: 12,
      rssAboveWarn: true,
      nowMs: Date.now(),
      config,
    });
    expect(state.highRssSinceMs).toBeUndefined();
    expect(state.consecutiveLowEvictionWarnings).toBe(0);
  });
});
