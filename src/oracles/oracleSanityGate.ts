import type { Address } from "viem";
import type { LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";

export interface OracleSanityInput {
  readonly chain: SupportedChain;
  readonly account: Address;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly chainlinkPriceRaw: bigint;
  readonly twapPriceRaw: bigint;
  readonly thresholdPct?: number;
}

export interface OracleSanityResult {
  readonly pass: boolean;
  readonly deviationPct: number;
}

export function evaluateOracleSanity(input: OracleSanityInput): OracleSanityResult {
  if (input.chainlinkPriceRaw <= 0n || input.twapPriceRaw <= 0n) {
    return { pass: false, deviationPct: Number.POSITIVE_INFINITY };
  }
  const deviationPct = Number(abs(input.chainlinkPriceRaw - input.twapPriceRaw) * 10_000n / input.chainlinkPriceRaw) / 100;
  return {
    pass: deviationPct <= (input.thresholdPct ?? 2),
    deviationPct,
  };
}

export function logOracleSanityFailure(
  logger: LoggerLike,
  input: OracleSanityInput,
  result: OracleSanityResult,
): void {
  logger.warn("oracle_sanity_deviation_block", {
    chain: input.chain,
    account: input.account,
    debtAsset: input.debtAsset,
    collateralAsset: input.collateralAsset,
    chainlinkPriceRaw: input.chainlinkPriceRaw.toString(),
    twapPriceRaw: input.twapPriceRaw.toString(),
    deviationPct: result.deviationPct,
    thresholdPct: input.thresholdPct ?? 2,
  });
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

