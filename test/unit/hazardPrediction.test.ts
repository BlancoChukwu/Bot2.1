import { describe, expect, it } from "vitest";
import {
  BayesianHazardModel,
  NoRegretOpportunityRanker,
  type HazardPredictionInput,
} from "../../src/optimization/hazardPrediction";

function input(
  opportunityId: string,
  features: readonly string[],
  expectedProfitBps: number,
): HazardPredictionInput {
  return {
    chain: "optimism",
    opportunityId,
    features,
    expectedProfitBps,
  };
}

describe("BayesianHazardModel", () => {
  it("lowers success probability after repeated failed outcomes for the same feature set", () => {
    const model = new BayesianHazardModel();
    const opportunity = input("op-risky", ["thin-margin", "hot-reserve"], 120);
    const before = model.predict(opportunity);

    model.recordOutcome({ ...opportunity, outcome: "lost_to_competitor" });
    model.recordOutcome({ ...opportunity, outcome: "reverted" });
    const after = model.predict(opportunity);

    expect(after.successProbabilityBps).toBeLessThan(before.successProbabilityBps);
    expect(after.hazardBps).toBeGreaterThan(before.hazardBps);
  });

  it("ranks higher expected value opportunities above learned hazardous ones", () => {
    const model = new BayesianHazardModel();
    const ranker = new NoRegretOpportunityRanker({ model });
    const safe = input("op-safe", ["deep-liquidity"], 90);
    const risky = input("op-risky", ["hot-reserve"], 180);

    model.recordOutcome({ ...risky, outcome: "lost_to_competitor" });
    model.recordOutcome({ ...risky, outcome: "lost_to_competitor" });
    model.recordOutcome({ ...risky, outcome: "lost_to_competitor" });
    model.recordOutcome({ ...safe, outcome: "won" });

    const ranked = ranker.rank([risky, safe]);

    expect(ranked.map((item) => item.opportunityId)).toEqual(["op-safe", "op-risky"]);
  });

  it("keeps learned hazards isolated by chain", () => {
    const model = new BayesianHazardModel();
    const optimism = input("op-optimism", ["hot-reserve"], 120);
    const arbitrum = { ...optimism, chain: "arbitrum" as const, opportunityId: "op-arbitrum" };

    model.recordOutcome({ ...optimism, outcome: "lost_to_competitor" });
    model.recordOutcome({ ...optimism, outcome: "lost_to_competitor" });

    expect(model.predict(arbitrum).successProbabilityBps).toBeGreaterThan(
      model.predict(optimism).successProbabilityBps,
    );
  });
});
