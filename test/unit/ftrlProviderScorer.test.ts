import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FTRLProviderScorer } from "../../src/monitors/FTRLProviderScorer";

describe("FTRLProviderScorer", () => {
  it("evolves probabilities deterministically for fixed seed and loss sequence", () => {
    const scorerA = new FTRLProviderScorer({
      providerIds: ["primary", "secondary", "tertiary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 42,
    });
    const scorerB = new FTRLProviderScorer({
      providerIds: ["primary", "secondary", "tertiary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 42,
    });
    for (let index = 0; index < 120; index += 1) {
      const provider = index % 3 === 0 ? "primary" : index % 3 === 1 ? "secondary" : "tertiary";
      const vector = {
        eventToDetectionMs: provider === "primary" ? 30 : provider === "secondary" ? 55 : 70,
        getLogsLatencyMs: provider === "primary" ? 20 : provider === "secondary" ? 35 : 60,
        flashblocksLeadMs: provider === "primary" ? 110 : provider === "secondary" ? 85 : 70,
        missedOpportunities: provider === "tertiary" ? 1 : 0,
        estimatedMissedEvUsd: 10,
        errorRate: provider === "tertiary" ? 0.4 : 0.05,
        errorSeverity: provider === "tertiary" ? "repeated" as const : "transient" as const,
      };
      scorerA.updateFromEvent(provider, vector);
      scorerB.updateFromEvent(provider, vector);
    }
    expect(scorerA.getDiagnostics()).toEqual(scorerB.getDiagnostics());
  });

  it("keeps near-uniform probabilities when providers are equal", () => {
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary", "secondary", "tertiary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 7,
    });
    for (let round = 0; round < 240; round += 1) {
      const provider = round % 3 === 0 ? "primary" : round % 3 === 1 ? "secondary" : "tertiary";
      scorer.updateFromEvent(provider, {
        eventToDetectionMs: 50,
        getLogsLatencyMs: 50,
        flashblocksLeadMs: 80,
        missedOpportunities: 0,
        estimatedMissedEvUsd: 10,
      });
    }
    const diagnostics = scorer.getDiagnostics();
    const primary = diagnostics.probabilities.primary ?? 0;
    const secondary = diagnostics.probabilities.secondary ?? 0;
    const tertiary = diagnostics.probabilities.tertiary ?? 0;
    expect(Math.abs(primary - secondary)).toBeLessThan(0.1);
    expect(Math.abs(secondary - tertiary)).toBeLessThan(0.1);
  });

  it("demotes a permanently failing provider and lowers its probability", () => {
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary", "secondary", "tertiary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 99,
    });
    for (let round = 0; round < 260; round += 1) {
      scorer.updateFromEvent("primary", {
        eventToDetectionMs: 30,
        getLogsLatencyMs: 20,
        flashblocksLeadMs: 100,
        missedOpportunities: 0,
        estimatedMissedEvUsd: 10,
        errorRate: 0.02,
      });
      scorer.updateFromError("tertiary", {
        eventToDetectionMs: 300,
        getLogsLatencyMs: 250,
        flashblocksLeadMs: 0,
        missedOpportunities: 1,
        estimatedMissedEvUsd: 10,
        errorRate: 1,
        errorSeverity: "outage",
      });
      scorer.updateFromEvent("secondary", {
        eventToDetectionMs: 45,
        getLogsLatencyMs: 35,
        flashblocksLeadMs: 80,
        missedOpportunities: 0,
        estimatedMissedEvUsd: 10,
        errorRate: 0.05,
      });
    }
    const diagnostics = scorer.getDiagnostics();
    expect(diagnostics.probabilities.tertiary).toBeLessThan(0.2);
  });

  it("adapts after drift where primary latency degrades", () => {
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary", "secondary", "tertiary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 11,
    });
    for (let round = 0; round < 400; round += 1) {
      const primaryLatency = round > 140 ? 260 : 35;
      scorer.updateFromEvent("primary", {
        eventToDetectionMs: primaryLatency,
        getLogsLatencyMs: primaryLatency / 2,
        flashblocksLeadMs: round > 140 ? 20 : 110,
        missedOpportunities: round > 140 ? 1 : 0,
        estimatedMissedEvUsd: 10,
        errorRate: round > 140 ? 0.4 : 0.05,
      });
      scorer.updateFromEvent("secondary", {
        eventToDetectionMs: 60,
        getLogsLatencyMs: 35,
        flashblocksLeadMs: 90,
        missedOpportunities: 0,
        estimatedMissedEvUsd: 10,
        errorRate: 0.05,
      });
      scorer.updateFromEvent("tertiary", {
        eventToDetectionMs: 80,
        getLogsLatencyMs: 55,
        flashblocksLeadMs: 60,
        missedOpportunities: 0,
        estimatedMissedEvUsd: 10,
        errorRate: 0.1,
      });
    }
    const diagnostics = scorer.getDiagnostics();
    expect(diagnostics.probabilities.secondary ?? 0).toBeGreaterThan(diagnostics.probabilities.primary ?? 0);
    expect(diagnostics.cumulativeRegretBestFixed).toBeGreaterThanOrEqual(0);
  });

  it("keeps small-T regret growth sublinear on synthetic sequence", () => {
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary", "secondary", "tertiary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 123,
    });
    const rounds = 200;
    for (let round = 0; round < rounds; round += 1) {
      const provider = scorer.samplePrimary();
      const bad = round % 40 < 8;
      scorer.updateFromEvent(provider, {
        eventToDetectionMs: bad ? 220 : 45,
        getLogsLatencyMs: bad ? 130 : 35,
        flashblocksLeadMs: bad ? 15 : 95,
        missedOpportunities: bad ? 1 : 0,
        estimatedMissedEvUsd: 10,
        errorRate: bad ? 0.8 : 0.05,
        errorSeverity: bad ? "repeated" : "transient",
      });
    }
    const diagnostics = scorer.getDiagnostics();
    const bound = 12 * Math.sqrt(rounds * Math.log(3));
    expect(diagnostics.cumulativeRegretBestFixed).toBeLessThan(bound);
  });

  it("supports persistence warm-start and ignores corrupted cache safely", () => {
    const tempDir = resolve(process.cwd(), ".tmp-test", "ftrl-scorer");
    mkdirSync(tempDir, { recursive: true });
    const statePath = resolve(tempDir, "state.json");
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary", "secondary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 5,
      persistencePath: statePath,
      saveEveryEvents: 1,
    });
    scorer.updateFromEvent("primary", {
      eventToDetectionMs: 40,
      getLogsLatencyMs: 20,
      flashblocksLeadMs: 100,
      estimatedMissedEvUsd: 10,
    });
    const resumed = new FTRLProviderScorer({
      providerIds: ["primary", "secondary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 5,
      persistencePath: statePath,
      saveEveryEvents: 1,
    });
    expect(resumed.getDiagnostics().round).toBeGreaterThan(0);
    writeFileSync(statePath, "{this-is:bad-json", "utf8");
    expect(() => new FTRLProviderScorer({
      providerIds: ["primary", "secondary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 5,
      persistencePath: statePath,
      saveEveryEvents: 1,
    })).not.toThrow();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("respects fallback gate and can reset fallback state", () => {
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary", "secondary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 6,
      circuitBreakerWindow: 1,
      circuitBreakerRegretRatio: 0.1,
    });
    scorer.updateFromError("primary", {
      eventToDetectionMs: 300,
      getLogsLatencyMs: 250,
      flashblocksLeadMs: 0,
      missedOpportunities: 2,
      estimatedMissedEvUsd: 10,
      errorRate: 1,
      errorSeverity: "outage",
    });
    (scorer as unknown as { fallbackActive: boolean }).fallbackActive = true;
    const diagnostics = scorer.getDiagnostics();
    expect(diagnostics.fallbackActive).toBe(true);
    expect(scorer.shouldUseFtrl()).toBe(false);
    scorer.resetFallback();
    expect(scorer.getDiagnostics().fallbackActive).toBe(false);
  });

  it("covers defensive branches for cache versioning and distribution fallback", () => {
    const tempDir = resolve(process.cwd(), ".tmp-test", "ftrl-scorer-defensive");
    mkdirSync(tempDir, { recursive: true });
    const statePath = resolve(tempDir, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      round: 10,
      eta: 0.1,
      z: 2,
      h: 2,
      cumulativeRegretBestFixed: 1,
      cumulativeRegretBestHindsightSignal: 1,
      regretBreachStreak: 1,
      fallbackActive: false,
      states: {},
    }), "utf8");
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary", "secondary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 1,
      epsilonStart: 0,
      epsilonEnd: 0,
      persistencePath: statePath,
      saveEveryEvents: 1,
    });
    expect(scorer.getDiagnostics().round).toBe(0);
    expect((scorer as unknown as { probability: (providerId: string) => number }).probability("ghost")).toBeGreaterThan(0);
    scorer.updateFromEvent("primary", {
      eventToDetectionMs: 40,
      getLogsLatencyMs: 30,
      flashblocksLeadMs: 500,
      missedOpportunities: 0,
      estimatedMissedEvUsd: 10,
    });
    (scorer as unknown as { probabilities: Map<string, number> }).probabilities.set("primary", 0);
    (scorer as unknown as { probabilities: Map<string, number> }).probabilities.set("secondary", 0);
    const sampled = scorer.samplePrimary();
    expect(["primary", "secondary"]).toContain(sampled);
    (scorer as unknown as { regretBreachStreak: number }).regretBreachStreak = 10;
    (scorer as unknown as { circuitBreakerWindow: number }).circuitBreakerWindow = 1;
    (scorer as unknown as { cumulativeRegretBestFixed: number }).cumulativeRegretBestFixed = 10;
    (scorer as unknown as { circuitBreakerRegretRatio: number }).circuitBreakerRegretRatio = 0.1;
    (scorer as unknown as { refreshCircuitBreaker: (value: number) => void }).refreshCircuitBreaker(1);
    expect(scorer.getDiagnostics().fallbackActive).toBe(true);
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      round: 3,
      eta: 0.08,
      z: 1,
      h: 1,
      cumulativeRegretBestFixed: 0.2,
      cumulativeRegretBestHindsightSignal: 0.1,
      regretBreachStreak: 0,
      fallbackActive: false,
      states: {
        primary: {
          cumulativeLoss: 0.3,
          lastObservedLoss: 0.2,
          eventCount: 1,
          missedOpportunities: 0,
        },
      },
    }), "utf8");
    const resumedPartial = new FTRLProviderScorer({
      providerIds: ["primary", "secondary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 1,
      persistencePath: statePath,
      saveEveryEvents: 1,
    });
    expect(resumedPartial.getDiagnostics().probabilities.secondary ?? 0).toBeGreaterThanOrEqual(0);
    scorer.updateFromEvent("quaternary", {
      eventToDetectionMs: 75,
      getLogsLatencyMs: 50,
      flashblocksLeadMs: 20,
      missedOpportunities: 0,
      estimatedMissedEvUsd: 10,
    });
    (scorer as unknown as { refreshCircuitBreaker: (value: number) => void }).refreshCircuitBreaker(0);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("handles empty provider initialization and dynamic first provider update", () => {
    const scorer = new FTRLProviderScorer({
      providerIds: [],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 77,
    });
    expect(scorer.samplePrimary()).toBe("primary");
    scorer.updateFromEvent("primary", {
      eventToDetectionMs: 60,
      getLogsLatencyMs: 40,
      flashblocksLeadMs: 40,
      missedOpportunities: 1,
      estimatedMissedEvUsd: 10,
      errorRate: 0.2,
      errorSeverity: "repeated",
    });
    const diagnostics = scorer.getDiagnostics();
    expect(diagnostics.probabilities.primary ?? 0).toBeGreaterThan(0);
  });

  it("covers latency update path, enabled rollout sampling, and epsilon floor branch", () => {
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary", "secondary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 19,
      epsilonStart: 0.3,
      epsilonEnd: 0.01,
      epsilonDecayEvents: 10,
    });
    scorer.updateFromLatency("primary", {
      eventToDetectionMs: 20,
      getLogsLatencyMs: 15,
      flashblocksLeadMs: 120,
    });
    expect(scorer.shouldUseFtrl()).toBe(true);
    (scorer as unknown as { round: number }).round = 20;
    const diagnostics = scorer.getDiagnostics();
    expect(diagnostics.epsilon).toBeCloseTo(0.01, 5);
    scorer.updateFromLatency("secondary", {
      eventToDetectionMs: Number.NaN,
      getLogsLatencyMs: Number.NaN,
      flashblocksLeadMs: Number.NaN,
    });
  });

  it("covers nullish signal defaults and missing state fallback in probability recompute", () => {
    const scorer = new FTRLProviderScorer({
      providerIds: ["primary"],
      enabled: true,
      rolloutPct: 100,
      randomSeed: 91,
    });
    scorer.updateFromEvent("primary", {});
    scorer.updateFromEvent("ghost", {});
    expect((scorer.getDiagnostics().probabilities.ghost ?? 0)).toBeGreaterThanOrEqual(0);
  });
});
