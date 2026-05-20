import type { Address } from "viem";
import type { LiquidationCandidate } from "./aaveV3";

/** Chainlink/Aave USD prices use 8 decimals in this codebase. */
const usdPriceScale = 1e8;

export interface DustFilterInput {
  readonly debtUsd: number;
  readonly minDebtUsd: number;
  readonly gasCostUsd?: number;
}

export type DustFilterReason =
  | "non_positive_debt"
  | "below_min_debt"
  | "below_gas_multiple"
  | "oracle_untrusted";

export interface DustFilterDecision {
  readonly debtUsd: number;
  readonly isDust: boolean;
  readonly reason?: DustFilterReason;
}

export function formatDustReasonLabel(
  reason: DustFilterReason | undefined,
  minDebtUsd: number,
): string {
  if (reason === undefined) {
    return "passed";
  }
  if (reason === "below_min_debt") {
    return `below_MIN_LIQUIDATION_DEBT_USD(${minDebtUsd})`;
  }
  if (reason === "below_gas_multiple") {
    return "below_GAS_COST_MULTIPLE";
  }
  if (reason === "oracle_untrusted") {
    return "oracle_untrusted";
  }
  return reason;
}

export function computeDebtUsdFromWei(
  debtRaw: bigint,
  debtDecimals: number,
  priceUsd8: bigint,
): number {
  if (debtRaw <= 0n || priceUsd8 <= 0n) {
    return 0;
  }
  const debtUnits = Number(debtRaw) / 10 ** debtDecimals;
  const priceUsd = Number(priceUsd8) / usdPriceScale;
  return debtUnits * priceUsd;
}

export function evaluateDustFilter(input: DustFilterInput): DustFilterDecision {
  const { debtUsd, minDebtUsd, gasCostUsd = 0 } = input;
  if (!Number.isFinite(debtUsd) || debtUsd <= 0) {
    return { debtUsd: 0, isDust: true, reason: "non_positive_debt" };
  }
  if (debtUsd < minDebtUsd) {
    return { debtUsd, isDust: true, reason: "below_min_debt" };
  }
  if (gasCostUsd > 0 && debtUsd < gasCostUsd * 2) {
    return { debtUsd, isDust: true, reason: "below_gas_multiple" };
  }
  return { debtUsd, isDust: false };
}

export function isDustLiquidationCandidate(input: DustFilterInput): boolean {
  return evaluateDustFilter(input).isDust;
}

export interface DustFilterLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

export function logLiquidationDustDecision(
  logger: DustFilterLogger,
  meta: {
    readonly chain: string;
    readonly account: Address;
    readonly debtAsset: Address;
    readonly collateralAsset: Address;
    readonly stage: string;
    readonly decision: DustFilterDecision;
    readonly minDebtUsd: number;
  },
): void {
  const dustReason = formatDustReasonLabel(meta.decision.reason, meta.minDebtUsd);
  const line = meta.decision.isDust
    ? `liquidation_dust_filtered | debtUSD: ${meta.decision.debtUsd} | isDust: true | dustReason: ${dustReason} | stage: ${meta.stage}`
    : `liquidation_dust_check_passed | debtUSD: ${meta.decision.debtUsd} | isDust: false | stage: ${meta.stage}`;
  const payload = {
    chain: meta.chain,
    account: meta.account,
    debtAsset: meta.debtAsset,
    collateralAsset: meta.collateralAsset,
    stage: meta.stage,
    debtUSD: meta.decision.debtUsd,
    isDust: meta.decision.isDust,
    dustReason,
    message: line,
  };
  logger.info(meta.decision.isDust ? "liquidation_dust_filtered" : "liquidation_dust_check_passed", payload);
}

export function filterDustLiquidationCandidates(
  candidates: readonly LiquidationCandidate[],
  input: {
    readonly minDebtUsd: number;
    readonly gasCostUsd: number;
    readonly resolveDebtUsd: (candidate: LiquidationCandidate) => number;
  },
): LiquidationCandidate[] {
  return candidates.filter((candidate) => {
    const debtUsd = input.resolveDebtUsd(candidate);
    return !isDustLiquidationCandidate({
      debtUsd,
      minDebtUsd: input.minDebtUsd,
      gasCostUsd: input.gasCostUsd,
    });
  });
}
