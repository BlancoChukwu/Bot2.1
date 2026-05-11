import type { SupportedChain } from "../config/chains";

export type HazardOutcome = "won" | "missed" | "reverted" | "lost_to_competitor";

export interface HazardPredictionInput {
  readonly chain: SupportedChain;
  readonly opportunityId: string;
  readonly features: readonly string[];
  readonly expectedProfitBps: number;
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
    const successProbabilityBps = Math.round(
      states.reduce((sum, state) => sum + this.featureSuccessBps(state), 0) / states.length,
    );
    const weightBps = Math.round(
      states.reduce((sum, state) => sum + state.weightBps, 0) / states.length,
    );
    const adjustedSuccessBps = Math.max(0, Math.min(bpsDenominator, (successProbabilityBps * weightBps) / bpsDenominator));
    const utilityScore = Math.round((input.expectedProfitBps * adjustedSuccessBps) / bpsDenominator);

    return {
      opportunityId: input.opportunityId,
      successProbabilityBps: Math.round(adjustedSuccessBps),
      hazardBps: Math.round(bpsDenominator - adjustedSuccessBps),
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
    return (state.successes * bpsDenominator) / (state.successes + state.failures);
  }
}

export interface NoRegretOpportunityRankerConfig {
  readonly model: BayesianHazardModel;
  readonly alpha?: number;
  readonly beta?: number;
  readonly l2Regularization?: number;
}

interface FtrlState {
  n: number;
  z: number;
}

export class FtrlOpportunityRanker {
  private readonly states = new Map<string, FtrlState>();
  private cumulativeRegret = 0;
  private readonly alpha: number;
  private readonly beta: number;
  private readonly l2Regularization: number;

  public constructor(private readonly config: NoRegretOpportunityRankerConfig) {
    this.alpha = config.alpha ?? 0.5;
    this.beta = config.beta ?? 1;
    this.l2Regularization = config.l2Regularization ?? 1;
  }

  public rank<T extends HazardPredictionInput>(inputs: readonly T[]): T[] {
    return [...inputs].sort((left, right) => {
      const leftScore = this.score(left);
      const rightScore = this.score(right);
      if (leftScore === rightScore) {
        return 0;
      }
      return leftScore > rightScore ? -1 : 1;
    });
  }

  public observe(input: HazardOutcomeInput): void {
    const reward = outcomeReward(input.outcome);
    const prediction = this.probability(input);
    this.cumulativeRegret += Math.abs(reward - prediction);
    for (const feature of this.featureKeys(input.chain, input.features)) {
      const state = this.stateFor(feature);
      const gradient = prediction - reward;
      const sigma = (Math.sqrt(state.n + gradient * gradient) - Math.sqrt(state.n)) / this.alpha;
      const weight = this.weightFor(state);
      state.z += gradient - sigma * weight;
      state.n += gradient * gradient;
    }
  }

  public getCumulativeRegret(): number {
    return this.cumulativeRegret;
  }

  private score(input: HazardPredictionInput): number {
    const utility = this.config.model.predict(input).utilityScore;
    const ftrlWeight = this.featureKeys(input.chain, input.features)
      .reduce((sum, feature) => sum + this.weightFor(this.stateFor(feature)), 0);
    return utility + ftrlWeight * input.expectedProfitBps;
  }

  private probability(input: HazardPredictionInput): number {
    const score = this.config.model.predict(input).successProbabilityBps / bpsDenominator;
    return Math.max(0, Math.min(1, score));
  }

  private featureKeys(chain: SupportedChain, features: readonly string[]): string[] {
    const scoped = features.length === 0 ? ["global"] : [...features];
    return scoped.map((feature) => `${chain}:${feature}`);
  }

  private stateFor(feature: string): FtrlState {
    const existing = this.states.get(feature);
    if (existing !== undefined) {
      return existing;
    }
    const created = { n: 0, z: 0 };
    this.states.set(feature, created);
    return created;
  }

  private weightFor(state: FtrlState): number {
    if (Math.abs(state.z) <= this.l2Regularization) {
      return 0;
    }
    const signed = state.z < 0 ? -1 : 1;
    return -((state.z - signed * this.l2Regularization)
      / ((this.beta + Math.sqrt(state.n)) / this.alpha + this.l2Regularization));
  }
}

export class NoRegretOpportunityRanker {
  private readonly ftrl: FtrlOpportunityRanker;

  public constructor(private readonly config: NoRegretOpportunityRankerConfig) {
    this.ftrl = new FtrlOpportunityRanker(config);
  }

  public rank<T extends HazardPredictionInput>(inputs: readonly T[]): T[] {
    return this.ftrl.rank(inputs);
  }

  public recordOutcome(input: HazardOutcomeInput): void {
    this.config.model.recordOutcome(input);
    this.ftrl.observe(input);
  }

  public cumulativeRegret(): number {
    return this.ftrl.getCumulativeRegret();
  }
}

function outcomeReward(outcome: HazardOutcome): number {
  if (outcome === "won") {
    return 1;
  }
  if (outcome === "missed") {
    return 0.4;
  }
  return 0;
}
