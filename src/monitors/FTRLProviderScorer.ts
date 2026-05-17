import { FTRLNoRegretScorer, type FTRLNoRegretScorerConfig } from "../optimization/FTRLNoRegretScorer";

export type ProviderErrorSeverity = "transient" | "repeated" | "outage";

export interface ProviderSignalVector {
  readonly eventToDetectionMs?: number;
  readonly getLogsLatencyMs?: number;
  readonly flashblocksLeadMs?: number;
  readonly missedOpportunities?: number;
  readonly estimatedMissedEvUsd?: number;
  readonly errorRate?: number;
  readonly errorSeverity?: ProviderErrorSeverity;
  readonly hazardBps?: number;
}

export interface ProviderScorerLossWeights {
  readonly latency: number;
  readonly missedEv: number;
  readonly getLogs: number;
  readonly flashblocks: number;
  readonly error: number;
  readonly hazard: number;
}

export interface ProviderScorerConfig extends FTRLNoRegretScorerConfig {
  readonly providerIds: readonly string[];
  readonly lossWeights?: Partial<ProviderScorerLossWeights>;
}

interface ProviderRoundLoss {
  readonly providerId: string;
  readonly total: number;
  readonly latency: number;
  readonly missedEv: number;
  readonly getLogs: number;
  readonly flashblocks: number;
  readonly error: number;
  readonly hazard: number;
}

interface ProviderState {
  eventCount: number;
  missedOpportunities: number;
}

export interface ProviderDiagnostics {
  readonly round: number;
  readonly eta: number;
  readonly epsilon: number;
  readonly mode: "legacy" | "ftrl";
  readonly fallbackActive: boolean;
  readonly selectedProvider: string;
  readonly instantaneousRegretBestFixed: number;
  readonly cumulativeRegretBestFixed: number;
  readonly cumulativeRegretBestHindsightSignal: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly cumulativeLosses: Readonly<Record<string, number>>;
  readonly lastRoundLosses: Readonly<Record<string, ProviderRoundLoss>>;
}

const defaultLossWeights: ProviderScorerLossWeights = {
  latency: 0.30,
  missedEv: 0.40,
  getLogs: 0.10,
  flashblocks: 0.10,
  error: 0.10,
  hazard: 0.15,
};

const errorSeverityMultiplier: Record<ProviderErrorSeverity, number> = {
  transient: 1,
  repeated: 1.5,
  outage: 3,
};

export class FTRLProviderScorer extends FTRLNoRegretScorer {
  private readonly latencyNormalizer = new SigmoidNormalizer();
  private readonly getLogsNormalizer = new SigmoidNormalizer();
  private readonly errorNormalizer = new SigmoidNormalizer();
  private readonly missedEvNormalizer = new OnlineMinMaxNormalizer();
  private readonly flashblocksPenaltyNormalizer = new OnlineMinMaxNormalizer();
  private readonly lossWeights: ProviderScorerLossWeights;
  private readonly providerStates = new Map<string, ProviderState>();
  private readonly lastRoundLosses = new Map<string, ProviderRoundLoss>();
  private selectedProvider = "primary";

  public constructor(config: ProviderScorerConfig) {
    super({
      ...config,
      actionIds: config.providerIds,
    });
    this.lossWeights = {
      ...defaultLossWeights,
      ...config.lossWeights,
    };
    for (const providerId of config.providerIds) {
      this.providerStates.set(providerId, { eventCount: 0, missedOpportunities: 0 });
    }
    this.selectedProvider = config.providerIds[0] ?? "primary";
  }

  public updateFromEvent(providerId: string, signal: ProviderSignalVector): ProviderRoundLoss {
    return this.update(providerId, signal);
  }

  public updateFromError(providerId: string, signal: ProviderSignalVector): ProviderRoundLoss {
    return this.update(providerId, {
      ...signal,
      errorRate: signal.errorRate ?? 1,
      errorSeverity: signal.errorSeverity ?? "outage",
    });
  }

  public updateFromLatency(providerId: string, signal: ProviderSignalVector): ProviderRoundLoss {
    return this.update(providerId, signal);
  }

  public rankProviders(): string[] {
    return this.rankActionIds(this.actionIdsSnapshot());
  }

  public samplePrimary(): string {
    const ranked = this.rankProviders();
    const fallback = ranked[0] ?? this.actionIdsSnapshot()[0] ?? "primary";
    const sampled = this.shouldUseScorer() ? this.sampleAction(ranked, fallback) : fallback;
    this.selectedProvider = sampled;
    return sampled;
  }

  public shouldUseFtrl(): boolean {
    return this.shouldUseScorer();
  }

  public override resetFallback(): void {
    super.resetFallback();
  }

  public getDiagnostics(): ProviderDiagnostics {
    const core = this.diagnostics();
    const detailedLosses: Record<string, ProviderRoundLoss> = {};
    for (const [providerId, loss] of this.lastRoundLosses.entries()) {
      detailedLosses[providerId] = loss;
    }
    return {
      round: core.round,
      eta: core.eta,
      epsilon: core.epsilon,
      mode: this.shouldUseScorer() ? "ftrl" : "legacy",
      fallbackActive: core.fallbackActive,
      selectedProvider: this.selectedProvider,
      instantaneousRegretBestFixed: core.instantaneousRegretBestFixed,
      cumulativeRegretBestFixed: core.cumulativeRegretBestFixed,
      cumulativeRegretBestHindsightSignal: core.cumulativeRegretBestHindsightSignal,
      probabilities: core.probabilities,
      cumulativeLosses: core.cumulativeLosses,
      lastRoundLosses: detailedLosses,
    };
  }

  private update(providerId: string, signal: ProviderSignalVector): ProviderRoundLoss {
    this.ensureAction(providerId);
    if (!this.providerStates.has(providerId)) {
      this.providerStates.set(providerId, { eventCount: 0, missedOpportunities: 0 });
    }
    const state = this.providerStates.get(providerId)!;
    state.eventCount += 1;
    state.missedOpportunities += signal.missedOpportunities ?? 0;

    const currentLoss = this.computeLoss(providerId, signal);
    const lossesByAction: Record<string, number> = {};
    const actionIds = this.actionIdsSnapshot();
    for (const actionId of actionIds) {
      if (actionId === providerId) {
        lossesByAction[actionId] = currentLoss.total;
        continue;
      }
      const previous = this.lastRoundLosses.get(actionId);
      lossesByAction[actionId] = previous === undefined ? 0.5 : clamp(previous.total * 0.98 + 0.01, 0, 1);
    }
    this.applyRoundLosses(lossesByAction);

    const nextRound = new Map<string, ProviderRoundLoss>();
    for (const actionId of actionIds) {
      if (actionId === providerId) {
        nextRound.set(actionId, currentLoss);
        continue;
      }
      const previous = this.lastRoundLosses.get(actionId);
      nextRound.set(actionId, {
        providerId: actionId,
        total: lossesByAction[actionId] ?? 0.5,
        latency: previous?.latency ?? 0,
        missedEv: previous?.missedEv ?? 0,
        getLogs: previous?.getLogs ?? 0,
        flashblocks: previous?.flashblocks ?? 0,
        error: previous?.error ?? 0,
        hazard: previous?.hazard ?? 0,
      });
    }
    this.lastRoundLosses.clear();
    for (const [actionId, loss] of nextRound.entries()) {
      this.lastRoundLosses.set(actionId, loss);
    }
    return currentLoss;
  }

  private computeLoss(providerId: string, signal: ProviderSignalVector): ProviderRoundLoss {
    const latency = this.latencyNormalizer.normalize(signal.eventToDetectionMs ?? 0);
    const getLogs = this.getLogsNormalizer.normalize(signal.getLogsLatencyMs ?? 0);
    const flashblocksLead = Math.max(0, signal.flashblocksLeadMs ?? 0);
    const flashblocksPenalty = this.flashblocksPenaltyNormalizer.normalize(Math.max(0, 200 - flashblocksLead));
    const missedEvRaw = Math.max(0, (signal.missedOpportunities ?? 0) * (signal.estimatedMissedEvUsd ?? 0));
    const missedEv = this.missedEvNormalizer.normalize(missedEvRaw);
    const severity = errorSeverityMultiplier[signal.errorSeverity ?? "transient"];
    const error = this.errorNormalizer.normalize(Math.max(0, signal.errorRate ?? 0) * severity);
    const hazard = clamp((signal.hazardBps ?? 0) / 10_000, 0, 1);
    const total = clamp(
      this.lossWeights.latency * latency
      + this.lossWeights.missedEv * missedEv
      + this.lossWeights.getLogs * getLogs
      + this.lossWeights.flashblocks * flashblocksPenalty
      + this.lossWeights.error * error
      + this.lossWeights.hazard * hazard,
      0,
      1,
    );
    return {
      providerId,
      total,
      latency,
      missedEv,
      getLogs,
      flashblocks: flashblocksPenalty,
      error,
      hazard,
    };
  }
}

class OnlineMinMaxNormalizer {
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;

  public normalize(value: number): number {
    const safe = Number.isFinite(value) ? value : 0;
    this.min = Math.min(this.min, safe);
    this.max = Math.max(this.max, safe);
    if (!Number.isFinite(this.min) || !Number.isFinite(this.max) || this.max === this.min) {
      return 0.5;
    }
    return clamp((safe - this.min) / (this.max - this.min), 0, 1);
  }
}

class SigmoidNormalizer {
  private mean = 0;
  private variance = 1;
  private initialized = false;
  private readonly alpha = 0.05;

  public normalize(value: number): number {
    const safe = Number.isFinite(value) ? value : 0;
    if (!this.initialized) {
      this.initialized = true;
      this.mean = safe;
      this.variance = 1;
    } else {
      const delta = safe - this.mean;
      this.mean += this.alpha * delta;
      this.variance = Math.max(1e-6, (1 - this.alpha) * this.variance + this.alpha * delta * delta);
    }
    const z = (safe - this.mean) / Math.max(Math.sqrt(this.variance), 1e-6);
    return 1 / (1 + Math.exp(-z));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
