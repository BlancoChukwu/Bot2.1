import { describe, expect, it } from "vitest";
import { parseEventPurityConfig, hfThresholdToWad } from "../../src/config/eventPurityConfig";

describe("eventPurityConfig", () => {
  it("defaults to shadow-only P0 flags", () => {
    const config = parseEventPurityConfig({});
    expect(config.enableArbitrage).toBe(false);
    expect(config.enableLiveTx).toBe(false);
    expect(config.enableWatchTierConfirm).toBe(false);
    expect(config.localHfUrgent).toBe(1.05);
    expect(config.shadowSampleRate).toBe(100);
    expect(config.bootstrapEnabled).toBe(true);
    expect(config.bootstrapLookbackDays).toBe(14);
    expect(config.bootstrapCacheEnabled).toBe(true);
    expect(config.bootstrapCacheTtlHours).toBe(24);
    expect(config.positionCacheHardCap).toBe(8_000);
  });

  it("converts hf thresholds to wad", () => {
    expect(hfThresholdToWad(1.05)).toBe(1_050_000_000_000_000_000n);
  });
});
