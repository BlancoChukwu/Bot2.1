import { resolveCloseFactorBps } from "./closeFactor";

export type AavePoolVersion = "v3" | "v4";

export function resolveAavePoolVersion(): AavePoolVersion {
  const raw = (process.env.AAVE_POOL_VERSION ?? "v3").trim().toLowerCase();
  return raw === "v4" ? "v4" : "v3";
}

/**
 * @deprecated Prefer resolveCloseFactorBps with collateralUsd + debtUsd.
 * HF-only fallback treats missing USD as above $2k so partial CF still applies for whales.
 */
export function defaultCloseFactorBps(poolVersion: AavePoolVersion, healthFactorWad: bigint): number {
  return resolveCloseFactorBps({
    healthFactorWad,
    collateralUsd: Number.POSITIVE_INFINITY,
    debtUsd: Number.POSITIVE_INFINITY,
    poolVersion,
  });
}
