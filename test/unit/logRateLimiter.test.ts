import { describe, expect, it } from "vitest";
import { HfPriceGapAggregator } from "../../src/utils/logRateLimiter";

describe("HfPriceGapAggregator", () => {
  it("aggregates skips and flushes after window", () => {
    const agg = new HfPriceGapAggregator({ windowSec: 60 });
    agg.record("0xabc", ["0xasset1"]);
    agg.record("0xdef", ["0xasset1", "0xasset2"]);
    const summary = agg.flush();
    expect(summary.totalSkips).toBe(2);
    expect(summary.gaps.length).toBeGreaterThan(0);
  });
});
