export type AavePoolVersion = "v3" | "v4";

export function resolveAavePoolVersion(): AavePoolVersion {
  const raw = (process.env.AAVE_POOL_VERSION ?? "v3").trim().toLowerCase();
  return raw === "v4" ? "v4" : "v3";
}

/** v3: protocol caps at 50% unless HF < 0.95 (then 100%). v4: target HF repayment — not yet wired. */
export function defaultCloseFactorBps(poolVersion: AavePoolVersion, healthFactorWad: bigint): number {
  if (poolVersion === "v4") {
    return 10_000;
  }
  return healthFactorWad < 950_000_000_000_000_000n ? 10_000 : 5_000;
}
