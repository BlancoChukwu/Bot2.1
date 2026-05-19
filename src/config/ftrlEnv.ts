import type { FTRLNoRegretScorerConfig } from "../optimization/FTRLNoRegretScorer";
import type { ProviderScorerConfig } from "../monitors/FTRLProviderScorer";

type Env = Record<string, string | undefined>;

export interface FtrlRuntimeConfig {
  readonly providerScoringEnabled: boolean;
  readonly rolloutPct: number;
  readonly randomSeed: number;
  readonly providerStateCachePath: string;
  readonly opportunityStateCachePath: string;
  readonly etaInit: number;
  readonly etaMin: number;
  readonly etaMax: number;
  readonly epsilonStart: number;
  readonly epsilonEnd: number;
  readonly epsilonDecayEvents: number;
  readonly hazardWeight: number;
  readonly circuitBreakerWindow: number;
  readonly warmupEvents: number;
}

function optionalEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function parseMinNumber(value: string | undefined, fallback: number, min: number, name: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be a number greater than or equal to ${min}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error("Boolean env vars must be true or false");
}

export function defaultFtrlRuntimeConfig(): FtrlRuntimeConfig {
  return {
    providerScoringEnabled: false,
    rolloutPct: 10,
    randomSeed: 1337,
    providerStateCachePath: "cache/ftrl-provider-scorer-state.json",
    opportunityStateCachePath: "cache/ftrl-opportunity-scorer-state.json",
    etaInit: 0.08,
    etaMin: 0.005,
    etaMax: 0.35,
    epsilonStart: 0.12,
    epsilonEnd: 0.02,
    epsilonDecayEvents: 3000,
    hazardWeight: 0.15,
    circuitBreakerWindow: 250,
    warmupEvents: 200,
  };
}

export function parseFtrlRuntimeConfig(env: Env): FtrlRuntimeConfig {
  return {
    providerScoringEnabled: parseBoolean(env.FTRL_PROVIDER_SCORING_ENABLED, false),
    rolloutPct: parseMinNumber(env.FTRL_ROLLOUT_PCT, 10, 0, "FTRL_ROLLOUT_PCT"),
    randomSeed: Math.floor(parseMinNumber(env.FTRL_RANDOM_SEED, 1337, 0, "FTRL_RANDOM_SEED")),
    providerStateCachePath:
      optionalEnv(env, "FTRL_PROVIDER_STATE_CACHE_PATH") ?? "cache/ftrl-provider-scorer-state.json",
    opportunityStateCachePath:
      optionalEnv(env, "FTRL_OPPORTUNITY_STATE_CACHE_PATH") ?? "cache/ftrl-opportunity-scorer-state.json",
    etaInit: parseMinNumber(env.FTRL_INITIAL_ETA, 0.08, 0, "FTRL_INITIAL_ETA"),
    etaMin: parseMinNumber(env.FTRL_ETA_MIN, 0.005, 0, "FTRL_ETA_MIN"),
    etaMax: parseMinNumber(env.FTRL_ETA_MAX, 0.35, 0, "FTRL_ETA_MAX"),
    epsilonStart: parseMinNumber(env.FTRL_EPSILON_INITIAL, 0.12, 0, "FTRL_EPSILON_INITIAL"),
    epsilonEnd: parseMinNumber(env.FTRL_EPSILON_FINAL, 0.02, 0, "FTRL_EPSILON_FINAL"),
    epsilonDecayEvents: Math.floor(
      parseMinNumber(env.FTRL_EPSILON_DECAY_ROUNDS, 3000, 1, "FTRL_EPSILON_DECAY_ROUNDS"),
    ),
    hazardWeight: parseMinNumber(env.FTRL_HAZARD_WEIGHT, 0.15, 0, "FTRL_HAZARD_WEIGHT"),
    circuitBreakerWindow: Math.floor(
      parseMinNumber(env.FTRL_CIRCUIT_BREAKER_N, 250, 1, "FTRL_CIRCUIT_BREAKER_N"),
    ),
    warmupEvents: Math.floor(parseMinNumber(env.FTRL_WARMUP_ROUNDS, 200, 1, "FTRL_WARMUP_ROUNDS")),
  };
}

export function toFtrlNoRegretScorerConfig(ftrl: FtrlRuntimeConfig): FTRLNoRegretScorerConfig {
  return {
    enabled: true,
    rolloutPct: ftrl.rolloutPct,
    randomSeed: ftrl.randomSeed,
    etaInit: ftrl.etaInit,
    etaMin: ftrl.etaMin,
    etaMax: ftrl.etaMax,
    epsilonStart: ftrl.epsilonStart,
    epsilonEnd: ftrl.epsilonEnd,
    epsilonDecayEvents: ftrl.epsilonDecayEvents,
    circuitBreakerWindow: ftrl.circuitBreakerWindow,
    warmupEvents: ftrl.warmupEvents,
  };
}

export function toProviderScorerConfig(
  ftrl: FtrlRuntimeConfig,
  providerIds: readonly string[],
): ProviderScorerConfig {
  return {
    ...toFtrlNoRegretScorerConfig(ftrl),
    enabled: ftrl.providerScoringEnabled,
    persistencePath: ftrl.providerStateCachePath,
    providerIds,
    lossWeights: { hazard: ftrl.hazardWeight },
  };
}

export function toOpportunityScorerConfig(ftrl: FtrlRuntimeConfig): FTRLNoRegretScorerConfig {
  return {
    ...toFtrlNoRegretScorerConfig(ftrl),
    persistencePath: ftrl.opportunityStateCachePath,
  };
}
