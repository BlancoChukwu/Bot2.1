import { describe, expect, it } from "vitest";
import { parseFtrlRuntimeConfig, toOpportunityScorerConfig, toProviderScorerConfig } from "../../src/config/ftrlEnv";

describe("ftrlEnv", () => {
  it("parses FTRL env vars from .env-style input", () => {
    const ftrl = parseFtrlRuntimeConfig({
      FTRL_PROVIDER_SCORING_ENABLED: "true",
      FTRL_ROLLOUT_PCT: "10",
      FTRL_RANDOM_SEED: "1337",
      FTRL_INITIAL_ETA: "1.0",
      FTRL_ETA_MIN: "0.01",
      FTRL_ETA_MAX: "5.0",
      FTRL_EPSILON_INITIAL: "0.10",
      FTRL_EPSILON_FINAL: "0.001",
      FTRL_EPSILON_DECAY_ROUNDS: "2000",
      FTRL_HAZARD_WEIGHT: "0.3",
      FTRL_CIRCUIT_BREAKER_N: "100",
      FTRL_WARMUP_ROUNDS: "50",
      FTRL_PROVIDER_STATE_CACHE_PATH: ".cache/ftrl_provider_weights.json",
      FTRL_OPPORTUNITY_STATE_CACHE_PATH: ".cache/ftrl_opportunity_weights.json",
    });

    expect(ftrl.etaInit).toBe(1);
    expect(ftrl.epsilonDecayEvents).toBe(2000);
    expect(ftrl.hazardWeight).toBe(0.3);
    expect(ftrl.warmupEvents).toBe(50);
  });

  it("maps provider scorer config with hazard loss weight", () => {
    const ftrl = parseFtrlRuntimeConfig({ FTRL_HAZARD_WEIGHT: "0.42" });
    const provider = toProviderScorerConfig(ftrl, ["primary", "secondary"]);
    expect(provider.lossWeights?.hazard).toBe(0.42);
    expect(provider.etaInit).toBeDefined();
  });

  it("maps opportunity scorer persistence path", () => {
    const ftrl = parseFtrlRuntimeConfig({
      FTRL_OPPORTUNITY_STATE_CACHE_PATH: "cache/custom-opportunity.json",
    });
    expect(toOpportunityScorerConfig(ftrl).persistencePath).toBe("cache/custom-opportunity.json");
  });
});
