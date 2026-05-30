import { describe, expect, it } from "vitest";
import { CompetitiveGapAnalyzer } from "../../src/observability/competitiveGapAnalyzer";

describe("CompetitiveGapAnalyzer", () => {
  it("computes same-block ratio from rolling outcomes", () => {
    const analyzer = new CompetitiveGapAnalyzer();
    const now = Date.now();
    analyzer.record({ opportunityId: "1", chain: "base", outcome: "won", recordedAtMs: now });
    analyzer.record({ opportunityId: "2", chain: "base", outcome: "missed", recordedAtMs: now });
    analyzer.record({ opportunityId: "3", chain: "base", outcome: "lost_to_competitor", recordedAtMs: now });
    expect(analyzer.sameBlockWouldBeRatio()).toBeCloseTo(1 / 3, 4);
  });
});

