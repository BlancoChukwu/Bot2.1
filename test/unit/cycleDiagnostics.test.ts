import { describe, expect, it } from "vitest";
import { CycleDiagnosticsCollector } from "../../src/observability/cycleDiagnostics";
import { createLogger } from "../../src/bot";

describe("CycleDiagnosticsCollector", () => {
  it("aggregates skip reasons and emits summary", () => {
    const collector = new CycleDiagnosticsCollector();
    collector.record({
      kind: "liquidation",
      account: "0x1",
      stage: "pipeline_enqueue",
      grossProfitUsd: 10,
      gasCostUsd: 1,
      netDeltaUsd: -0.5,
      failureMarginBps: -50,
      skipReason: "below_floor",
      passed: false,
    });
    collector.recordSim();
    const snap = collector.snapshot(0, 2);
    expect(snap.evaluations).toBe(1);
    expect(snap.sims).toBe(1);
    expect(snap.opps_per_block).toBe(0.5);
    expect(snap.summary).toContain("below_floor:1");
    collector.emit(createLogger("silent"), 0, 2);
  });
});
