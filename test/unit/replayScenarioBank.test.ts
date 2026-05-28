import { describe, expect, it } from "vitest";
import { loadReplayScenarioBank } from "../../src/backtesting/replayScenarioBank";

describe("replayScenarioBank", () => {
  it("loads 50+ scenarios for harness", () => {
    const scenarios = loadReplayScenarioBank();
    expect(scenarios.length).toBeGreaterThanOrEqual(50);
  });
});
