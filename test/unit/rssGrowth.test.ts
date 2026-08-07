import { describe, expect, it } from "vitest";
import { rssGrowthMbPerHour, rssGrowthMbPerHourFullWindow } from "../../src/utils/rssGrowth";

describe("rssGrowthMbPerHour", () => {
  it("excludes warm-up ramp from slope", () => {
    const t0 = Date.parse("2026-07-21T17:46:00.000Z");
    const samples = [
      { timeMs: t0, rssMb: 204 },
      { timeMs: t0 + 30 * 60_000, rssMb: 380 },
      { timeMs: t0 + 90 * 60_000, rssMb: 382 },
      { timeMs: t0 + 150 * 60_000, rssMb: 384 },
    ];
    const postWarmup = rssGrowthMbPerHour(samples);
    const full = rssGrowthMbPerHourFullWindow(samples);
    expect(postWarmup).toBeCloseTo(2, 0); // +4MB over 2h after warm-up
    expect(full).toBeGreaterThan(50); // warm-up dominates full window
  });
});
