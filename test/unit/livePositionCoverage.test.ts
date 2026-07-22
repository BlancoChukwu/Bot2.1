import { describe, expect, it } from "vitest";
import { computeLivePositionCoveragePct } from "../../src/monitors/livePositionCoverage";

describe("computeLivePositionCoveragePct", () => {
  it("returns 0 when no users seeded", () => {
    expect(computeLivePositionCoveragePct(50000, 0)).toBe(0);
  });

  it("recomputes from live cache size / usersSeeded", () => {
    expect(computeLivePositionCoveragePct(50000, 61515)).toBeCloseTo(81.281, 3);
  });

  it("moves when cache size changes", () => {
    const a = computeLivePositionCoveragePct(48635, 61515);
    const b = computeLivePositionCoveragePct(48640, 61515);
    expect(b).toBeGreaterThan(a);
  });
});
