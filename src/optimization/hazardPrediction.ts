import type { SupportedChain } from "../config/chains";
import { FTRLNoRegretScorer, type FTRLNoRegretScorerConfig } from "./FTRLNoRegretScorer";

export type HazardOutcome = "won" | "missed" | "reverted" | "lost_to_competitor";

export interface OpportunitySignalVector {
  readonly estimatedEvMissUsd?: number;
  readonly gasSpikePenalty?: number;
  readonly closeFactorRisk?: number;
  readonly oracleLatencyMs?: number;
}

export interface HazardPredictionInput {
  readonly chain: SupportedChain;
  readonly opportunityId: string;
  readonly features: readonly string[];
  readonly expectedProfitBps: number;
  readonly signals?: OpportunitySignalVector;
}

export interface HazardOutcomeInput extends HazardPredictionInput {
  readonly outcome: HazardOutcome;
}

export interface HazardPrediction {
  readonly opportunityId: string;
  readonly successProbabilityBps: number;
  readonly hazardBps: number;
  readonly utilityScore: number;
}

export interface BayesianHazardModelConfig {
  readonly priorSuccesses?: number;
  readonly priorFailures?: number;
  readonly learningRateBps?: number;
}

interface FeatureState {
  successes: number;
  failures: number;
  weightBps: number;
}

export interface NoRegretOpportunityRankerConfig {
  readonly model: BayesianHazardModel;
  readonly scorerConfig?: FTRLNoRegretScorerConfig;
}

export interface OpportunityRankDiagnostics {
  readonly cumulativeRegret: number;
  readonly eta: number;
}

const bpsDenominator = 10_000;

export class BayesianHazardModel {
  private readonly featureStates = new Map<string, FeatureState>();
  private readonly priorSuccesses: number;
  private readonly priorFailures: number;
  private readonly learningRateBps: number;

  public constructor(config: BayesianHazardModelConfig = {}) {
    this.priorSuccesses = config.priorSuccesses ?? 1;
    this.priorFailures = config.priorFailures ?? 1;
    this.learningRateBps = config.learningRateBps ?? 1_000;
  }

  public predict(input: HazardPredictionInput): HazardPrediction {
    const states = this.statesFor(input.chain, input.features);
    const successProbabilityBps = Math.round(states.reduce((sum, state) => sum + this.featureSuccessBps(state), 0) / states.length);
    const weightBps = Math.round(states.reduce((sum, state) => sum + state.weightBps, 0) / states.length);
    const adjustedSuccessBps = clamp((successProbabilityBps * weightBps) / bpsDenominator, 0, bpsDenominator);
    const utilityScore = Math.round((input.expectedProfitBps * adjustedSuccessBps) / bpsDenominator);
    return {
      opportunityId: input.opportunityId,
      successProbabilityBps: adjustedSuccessBps,
      hazardBps: bpsDenominator - adjustedSuccessBps,
      utilityScore,
    };
  }

  public recordOutcome(input: HazardOutcomeInput): void {
    for (const feature of this.featureKeys(input.chain, input.features)) {
      const state = this.stateFor(feature);
      if (input.outcome === "won") {
        state.successes += 1;
        state.weightBps = Math.min(15_000, state.weightBps + this.learningRateBps);
      } else {
        state.failures += 1;
        state.weightBps = Math.max(1_000, state.weightBps - this.learningRateBps);
      }
    }
  }

  private statesFor(chain: SupportedChain, features: readonly string[]): FeatureState[] {
    return this.featureKeys(chain, features).map((feature) => this.stateFor(feature));
  }

  private featureKeys(chain: SupportedChain, features: readonly string[]): string[] {
    const scoped = features.length === 0 ? ["global"] : [...features];
    return scoped.map((feature) => `${chain}:${feature}`);
  }

  private stateFor(feature: string): FeatureState {
    const existing = this.featureStates.get(feature);
    if (existing !== undefined) {
      return existing;
    }
    const created = {
      successes: this.priorSuccesses,
      failures: this.priorFailures,
      weightBps: bpsDenominator,
    };
    this.featureStates.set(feature, created);
    return created;
  }

  private featureSuccessBps(state: FeatureState): number {
    return Math.round((state.successes * bpsDenominator) / (state.successes + state.failures));
  }
}

class OpportunityFTRLScorer extends FTRLNoRegretScorer {
  private readonly lastLossByAction = new Map<string, number>();

  public constructor(config: FTRLNoRegretScorerConfig = {}) {
    super(config);
  }

  public rank<T extends HazardPredictionInput>(inputs: readonly T[], model: BayesianHazardModel): T[] {
    const scored = inputs.map((input) => {
      const actionId = actionIdFor(input);
      this.ensureAction(actionId);
      const prediction = model.predict(input);
      const hazard = prediction.hazardBps / bpsDenominator;
      const loss = expectedLoss(input, hazard);
      const probability = this.probability(actionId);
      const score = prediction.utilityScore - (loss * input.expectedProfitBps) - prediction.hazardBps / 100 + probability * 25;
      return { input, score };
    });
    return scored
      .sort((left, right) => (right.score === left.score ? 0 : right.score > left.score ? 1 : -1))
      .map((entry) => entry.input);
  }

  public observe(input: HazardOutcomeInput, model: BayesianHazardModel): void {
    const actionId = actionIdFor(input);
    this.ensureAction(actionId);
    const lossesByAction: Record<string, number> = {};
    for (const knownActionId of this.actionIdsSnapshot()) {
      if (knownActionId === actionId) {
        const hazard = model.predict(input).hazardBps / bpsDenominator;
        lossesByAction[knownActionId] = observedLoss(input, hazard);
      } else {
        const previous = this.lastLossByAction.get(knownActionId);
        lossesByAction[knownActionId] = previous === undefined ? 0.5 : clamp(previous * 0.99 + 0.005, 0, 1);
      }
    }
    this.applyRoundLosses(lossesByAction);
    this.lastLossByAction.clear();
    for (const [knownActionId, loss] of Object.entries(lossesByAction)) {
      this.lastLossByAction.set(knownActionId, loss);
    }
  }
}

export class NoRegretOpportunityRanker {
  private readonly scorer: OpportunityFTRLScorer;

  public constructor(private readonly config: NoRegretOpportunityRankerConfig) {
    this.scorer = new OpportunityFTRLScorer({
      enabled: true,
      rolloutPct: 100,
      epsilonStart: 0.05,
      epsilonEnd: 0.01,
      ...(config.scorerConfig ?? {}),
    });
  }

  public rank<T extends HazardPredictionInput>(inputs: readonly T[]): T[] {
    return this.scorer.rank(inputs, this.config.model);
  }

  public recordOutcome(input: HazardOutcomeInput): void {
    this.config.model.recordOutcome(input);
    this.scorer.observe(input, this.config.model);
  }

  public cumulativeRegret(): number {
    return this.scorer.diagnostics().cumulativeRegretBestFixed;
  }

  public diagnostics(): OpportunityRankDiagnostics {
    const diagnostics = this.scorer.diagnostics();
    return {
      cumulativeRegret: diagnostics.cumulativeRegretBestFixed,
      eta: diagnostics.eta,
    };
  }
}

function actionIdFor(input: HazardPredictionInput): string {
  const features = [...input.features].sort().join("|");
  return `${input.chain}:${features.length === 0 ? "global" : features}`;
}

function expectedLoss(input: HazardPredictionInput, hazard: number): number {
  const evMiss = normalizeEvMiss(input.signals?.estimatedEvMissUsd, input.expectedProfitBps);
  const gasPenalty = clamp(input.signals?.gasSpikePenalty ?? 0, 0, 1);
  const closeFactorRisk = clamp(input.signals?.closeFactorRisk ?? 0, 0, 1);
  const oracleLatency = normalizeLatency(input.signals?.oracleLatencyMs ?? 0);
  return clamp(
    0.40 * evMiss
    + 0.20 * gasPenalty
    + 0.20 * closeFactorRisk
    + 0.10 * oracleLatency
    + 0.10 * hazard,
    0,
    1,
  );
}

function observedLoss(input: HazardOutcomeInput, hazard: number): number {
  const base = expectedLoss(input, hazard);
  const rewardLoss = 1 - outcomeReward(input.outcome);
  return clamp(0.6 * base + 0.4 * rewardLoss, 0, 1);
}

function outcomeReward(outcome: HazardOutcome): number {
  if (outcome === "won") {
    return 1;
  }
  if (outcome === "missed") {
    return 0.4;
  }
  if (outcome === "lost_to_competitor") {
    return 0.1;
  }
  return 0;
}

function normalizeEvMiss(estimatedEvMissUsd: number | undefined, expectedProfitBps: number): number {
  const fallback = Math.max(0, expectedProfitBps) / (bpsDenominator * 4);
  if (estimatedEvMissUsd === undefined || !Number.isFinite(estimatedEvMissUsd)) {
    return clamp(fallback, 0, 1);
  }
  return clamp(1 - Math.exp(-Math.max(0, estimatedEvMissUsd) / 25), 0, 1);
}

function normalizeLatency(latencyMs: number): number {
  const safe = Number.isFinite(latencyMs) ? latencyMs : 0;
  return clamp(1 - Math.exp(-Math.max(0, safe) / 250), 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
