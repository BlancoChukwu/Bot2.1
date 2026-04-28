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
}

export class NoRegretOpportunityRanker {
  public constructor(private readonly config: NoRegretOpportunityRankerConfig) {}

  public rank<T extends HazardPredictionInput>(inputs: readonly T[]): T[] {
    return [...inputs].sort((left, right) => {
      const leftScore = this.config.model.predict(left).utilityScore;
      const rightScore = this.config.model.predict(right).utilityScore;
      if (leftScore === rightScore) {
        return 0;
      }

      return leftScore > rightScore ? -1 : 1;
    });
  }
}
