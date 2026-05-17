import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FTRLNoRegretScorerConfig {
  readonly actionIds?: readonly string[];
  readonly enabled?: boolean;
  readonly rolloutPct?: number;
  readonly randomSeed?: number;
  readonly etaInit?: number;
  readonly etaMin?: number;
  readonly etaMax?: number;
  readonly etaWarmupFloor?: number;
  readonly warmupEvents?: number;
  readonly epsilonStart?: number;
  readonly epsilonEnd?: number;
  readonly epsilonDecayEvents?: number;
  readonly circuitBreakerWindow?: number;
  readonly circuitBreakerRegretRatio?: number;
  readonly saveEveryEvents?: number;
  readonly persistencePath?: string;
}

interface ActionState {
  cumulativeLoss: number;
  lastObservedLoss: number;
}

interface PersistedState {
  readonly version: 1;
  readonly round: number;
  readonly eta: number;
  readonly z: number;
  readonly h: number;
  readonly cumulativeRegretBestFixed: number;
  readonly cumulativeRegretBestHindsightSignal: number;
  readonly regretBreachStreak: number;
  readonly fallbackActive: boolean;
  readonly states: Record<string, ActionState>;
}

export interface FTRLNoRegretDiagnostics {
  readonly round: number;
  readonly eta: number;
  readonly epsilon: number;
  readonly fallbackActive: boolean;
  readonly instantaneousRegretBestFixed: number;
  readonly cumulativeRegretBestFixed: number;
  readonly cumulativeRegretBestHindsightSignal: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly cumulativeLosses: Readonly<Record<string, number>>;
}

const stateVersion = 1;

export class FTRLNoRegretScorer {
  private readonly states = new Map<string, ActionState>();
  private readonly probabilities = new Map<string, number>();
  private readonly rng: () => number;
  private readonly enabled: boolean;
  private readonly rolloutPct: number;
  private readonly etaMin: number;
  private readonly etaMax: number;
  private readonly etaWarmupFloor: number;
  private readonly warmupEvents: number;
  private readonly epsilonStart: number;
  private readonly epsilonEnd: number;
  private readonly epsilonDecayEvents: number;
  private readonly circuitBreakerWindow: number;
  private readonly circuitBreakerRegretRatio: number;
  private readonly saveEveryEvents: number;
  private readonly persistencePath: string | undefined;

  private actionIds: string[];
  private round = 0;
  private eta: number;
  private z = 1;
  private h = 1;
  private instantaneousRegretBestFixed = 0;
  private cumulativeRegretBestFixed = 0;
  private cumulativeRegretBestHindsightSignal = 0;
  private regretBreachStreak = 0;
  private fallbackActive = false;

  public constructor(config: FTRLNoRegretScorerConfig) {
    this.actionIds = [...new Set(config.actionIds ?? [])];
    this.enabled = config.enabled ?? true;
    this.rolloutPct = clamp(config.rolloutPct ?? 100, 0, 100);
    this.eta = config.etaInit ?? 0.08;
    this.etaMin = config.etaMin ?? 0.005;
    this.etaMax = config.etaMax ?? 0.35;
    this.etaWarmupFloor = config.etaWarmupFloor ?? 0.03;
    this.warmupEvents = Math.max(1, Math.floor(config.warmupEvents ?? 200));
    this.epsilonStart = clamp(config.epsilonStart ?? 0.12, 0, 1);
    this.epsilonEnd = clamp(config.epsilonEnd ?? 0.02, 0, 1);
    this.epsilonDecayEvents = Math.max(1, Math.floor(config.epsilonDecayEvents ?? 3_000));
    this.circuitBreakerWindow = Math.max(1, Math.floor(config.circuitBreakerWindow ?? 250));
    this.circuitBreakerRegretRatio = Math.max(0.01, config.circuitBreakerRegretRatio ?? 2);
    this.saveEveryEvents = Math.max(1, Math.floor(config.saveEveryEvents ?? 50));
    this.persistencePath = config.persistencePath;
    this.rng = mulberry32(config.randomSeed ?? 1_337);
    this.initializeActions();
    this.loadState();
    this.recomputeProbabilities();
  }

  protected ensureAction(actionId: string): void {
    if (this.states.has(actionId)) {
      return;
    }
    this.actionIds.push(actionId);
    this.states.set(actionId, { cumulativeLoss: 0, lastObservedLoss: 0 });
    this.recomputeProbabilities();
  }

  protected applyRoundLosses(lossesByAction: Readonly<Record<string, number>>): void {
    for (const actionId of Object.keys(lossesByAction)) {
      this.ensureAction(actionId);
    }
    const probabilitiesBefore = new Map(this.probabilities);
    let expectedLoss = 0;
    let bestFixedLoss = Number.POSITIVE_INFINITY;
    for (const actionId of this.actionIds) {
      const roundedLoss = clamp(lossesByAction[actionId] ?? this.states.get(actionId)?.lastObservedLoss ?? 0.5, 0, 1);
      const state = this.states.get(actionId);
      if (state === undefined) {
        continue;
      }
      state.lastObservedLoss = roundedLoss;
      state.cumulativeLoss += roundedLoss;
      const probability = probabilitiesBefore.get(actionId) ?? (1 / Math.max(1, this.actionIds.length));
      expectedLoss += probability * roundedLoss;
      bestFixedLoss = Math.min(bestFixedLoss, roundedLoss);
    }
    this.instantaneousRegretBestFixed = Math.max(0, expectedLoss - bestFixedLoss);
    this.cumulativeRegretBestFixed += this.instantaneousRegretBestFixed;
    const minCumulativeLoss = Math.min(...[...this.states.values()].map((state) => state.cumulativeLoss));
    this.cumulativeRegretBestHindsightSignal = Math.max(
      0,
      expectedLoss + this.cumulativeRegretBestHindsightSignal - minCumulativeLoss,
    );

    const variance = weightedVariance(this.states, probabilitiesBefore);
    const squared = weightedSquare(this.states, probabilitiesBefore) + 1e-9;
    this.z += variance;
    this.h += squared;
    this.eta = nextEta(this.eta, this.z, this.h, this.round, this.warmupEvents, this.etaWarmupFloor, this.etaMin, this.etaMax);
    this.round += 1;
    this.refreshCircuitBreaker(minCumulativeLoss);
    this.recomputeProbabilities();
    this.persistStateIfNeeded();
  }

  protected rankActionIds(actionIds: readonly string[]): string[] {
    return [...actionIds].sort((left, right) => this.probability(right) - this.probability(left));
  }

  protected probability(actionId: string): number {
    return this.probabilities.get(actionId) ?? (1 / Math.max(1, this.actionIds.length));
  }

  protected sampleAction(actionIds: readonly string[], fallback: string): string {
    if (actionIds.length === 0) {
      return fallback;
    }
    const epsilon = this.currentEpsilon();
    if (this.rng() < epsilon) {
      const index = Math.floor(this.rng() * actionIds.length);
      return actionIds[index] ?? fallback;
    }
    const target = this.rng();
    let cumulative = 0;
    for (const actionId of actionIds) {
      cumulative += this.probability(actionId);
      if (target <= cumulative) {
        return actionId;
      }
    }
    return fallback;
  }

  public shouldUseScorer(): boolean {
    if (!this.enabled || this.fallbackActive) {
      return false;
    }
    return this.rng() <= this.rolloutPct / 100;
  }

  public resetFallback(): void {
    this.fallbackActive = false;
    this.regretBreachStreak = 0;
  }

  public diagnostics(): FTRLNoRegretDiagnostics {
    const probabilities: Record<string, number> = {};
    const cumulativeLosses: Record<string, number> = {};
    for (const actionId of this.actionIds) {
      probabilities[actionId] = this.probability(actionId);
      cumulativeLosses[actionId] = this.states.get(actionId)?.cumulativeLoss ?? 0;
    }
    return {
      round: this.round,
      eta: this.eta,
      epsilon: this.currentEpsilon(),
      fallbackActive: this.fallbackActive,
      instantaneousRegretBestFixed: this.instantaneousRegretBestFixed,
      cumulativeRegretBestFixed: this.cumulativeRegretBestFixed,
      cumulativeRegretBestHindsightSignal: this.cumulativeRegretBestHindsightSignal,
      probabilities,
      cumulativeLosses,
    };
  }

  protected actionIdsSnapshot(): readonly string[] {
    return [...this.actionIds];
  }

  private initializeActions(): void {
    for (const actionId of this.actionIds) {
      if (!this.states.has(actionId)) {
        this.states.set(actionId, { cumulativeLoss: 0, lastObservedLoss: 0 });
      }
    }
  }

  private recomputeProbabilities(): void {
    if (this.actionIds.length === 0) {
      return;
    }
    const losses = this.actionIds.map((actionId) => this.states.get(actionId)?.cumulativeLoss ?? 0);
    const minLoss = Math.min(...losses, 0);
    let totalWeight = 0;
    const weights = new Map<string, number>();
    for (const actionId of this.actionIds) {
      const cumulativeLoss = this.states.get(actionId)?.cumulativeLoss ?? 0;
      const shiftedLoss = Math.max(0, cumulativeLoss - minLoss);
      const weight = 1 / Math.pow(1 + this.eta * shiftedLoss, 2);
      totalWeight += weight;
      weights.set(actionId, weight);
    }
    const epsilon = this.currentEpsilon();
    const uniformMass = epsilon / this.actionIds.length;
    for (const actionId of this.actionIds) {
      const base = totalWeight <= 0 ? (1 / this.actionIds.length) : (weights.get(actionId) ?? 0) / totalWeight;
      this.probabilities.set(actionId, (1 - epsilon) * base + uniformMass);
    }
  }

  private currentEpsilon(): number {
    const progress = this.round / this.epsilonDecayEvents;
    if (progress >= 1) {
      return this.epsilonEnd;
    }
    const scale = Math.exp(-4 * progress);
    return this.epsilonEnd + (this.epsilonStart - this.epsilonEnd) * scale;
  }

  private refreshCircuitBreaker(bestFixedCumulativeLoss: number): void {
    if (bestFixedCumulativeLoss <= 0) {
      this.regretBreachStreak = 0;
      return;
    }
    const ratio = this.cumulativeRegretBestFixed / bestFixedCumulativeLoss;
    if (ratio > this.circuitBreakerRegretRatio) {
      this.regretBreachStreak += 1;
    } else {
      this.regretBreachStreak = 0;
    }
    if (this.regretBreachStreak >= this.circuitBreakerWindow) {
      this.fallbackActive = true;
    }
  }

  private loadState(): void {
    if (this.persistencePath === undefined || !existsSync(this.persistencePath)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.persistencePath, "utf8")) as PersistedState;
      if (parsed.version !== stateVersion) {
        return;
      }
      this.round = Math.max(0, parsed.round);
      this.eta = clamp(parsed.eta, this.etaMin, this.etaMax);
      this.z = Math.max(1e-9, parsed.z);
      this.h = Math.max(1e-9, parsed.h);
      this.cumulativeRegretBestFixed = Math.max(0, parsed.cumulativeRegretBestFixed);
      this.cumulativeRegretBestHindsightSignal = Math.max(0, parsed.cumulativeRegretBestHindsightSignal);
      this.regretBreachStreak = Math.max(0, parsed.regretBreachStreak);
      this.fallbackActive = parsed.fallbackActive;
      for (const actionId of this.actionIds) {
        const persisted = parsed.states[actionId];
        if (persisted !== undefined) {
          this.states.set(actionId, { ...persisted });
        }
      }
    } catch {
      // ignore invalid persisted state
    }
  }

  private persistStateIfNeeded(): void {
    if (this.persistencePath === undefined || this.round === 0 || this.round % this.saveEveryEvents !== 0) {
      return;
    }
    const states: Record<string, ActionState> = {};
    for (const [actionId, state] of this.states.entries()) {
      states[actionId] = state;
    }
    const payload: PersistedState = {
      version: stateVersion,
      round: this.round,
      eta: this.eta,
      z: this.z,
      h: this.h,
      cumulativeRegretBestFixed: this.cumulativeRegretBestFixed,
      cumulativeRegretBestHindsightSignal: this.cumulativeRegretBestHindsightSignal,
      regretBreachStreak: this.regretBreachStreak,
      fallbackActive: this.fallbackActive,
      states,
    };
    const tempPath = `${this.persistencePath}.tmp`;
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tempPath, this.persistencePath);
    } catch {
      // best effort persistence
    }
  }
}

function weightedVariance(
  states: ReadonlyMap<string, ActionState>,
  probabilities: ReadonlyMap<string, number>,
): number {
  let mean = 0;
  for (const [actionId, state] of states.entries()) {
    mean += (probabilities.get(actionId) ?? 0) * state.lastObservedLoss;
  }
  let variance = 0;
  for (const [actionId, state] of states.entries()) {
    const delta = state.lastObservedLoss - mean;
    variance += (probabilities.get(actionId) ?? 0) * delta * delta;
  }
  return Math.max(0, variance);
}

function weightedSquare(
  states: ReadonlyMap<string, ActionState>,
  probabilities: ReadonlyMap<string, number>,
): number {
  let total = 0;
  for (const [actionId, state] of states.entries()) {
    total += (probabilities.get(actionId) ?? 0) * state.lastObservedLoss * state.lastObservedLoss;
  }
  return Math.max(0, total);
}

function nextEta(
  previousEta: number,
  z: number,
  h: number,
  round: number,
  warmupEvents: number,
  etaWarmupFloor: number,
  etaMin: number,
  etaMax: number,
): number {
  const denominator = 1 + Math.sqrt(1 + (4 * z * previousEta * previousEta) / Math.max(h, 1e-9));
  const candidate = previousEta * (2 / denominator);
  const warmupBounded = round < warmupEvents ? Math.max(candidate, etaWarmupFloor) : candidate;
  return clamp(warmupBounded, etaMin, etaMax);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
