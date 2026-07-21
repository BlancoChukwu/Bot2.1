import type { Address } from "viem";
import type { LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";
import {
  ORACLE_SANITY_DEVIATION_THRESHOLD_PCT,
  resolveUniswapV3TwapUsd8,
  type ResolveTwapUsdInput,
  type TwapUsdResult,
} from "../oracle/uniswapV3TwapPrice";

export interface OracleSanityInput {
  readonly chain: SupportedChain;
  readonly account: Address;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly chainlinkPriceRaw: bigint;
  readonly twapPriceRaw: bigint;
  readonly thresholdPct?: number;
  readonly assetRole?: "debt" | "collateral";
}

export interface OracleSanityResult {
  readonly pass: boolean;
  readonly deviationPct: number;
}

/**
 * Single-asset Chainlink vs TWAP deviation.
 * For multi-hop TWAP, `twapPriceRaw` must already be the *compounded* USD price —
 * never apply a looser per-hop tolerance here.
 */
export function evaluateOracleSanity(input: OracleSanityInput): OracleSanityResult {
  if (input.chainlinkPriceRaw <= 0n || input.twapPriceRaw <= 0n) {
    return { pass: false, deviationPct: Number.POSITIVE_INFINITY };
  }
  const deviationPct =
    Number(abs(input.chainlinkPriceRaw - input.twapPriceRaw) * 10_000n / input.chainlinkPriceRaw) / 100;
  return {
    pass: deviationPct <= (input.thresholdPct ?? ORACLE_SANITY_DEVIATION_THRESHOLD_PCT),
    deviationPct,
  };
}

export interface AssetOracleSanityDetail {
  readonly asset: Address;
  readonly role: "debt" | "collateral";
  readonly pass: boolean;
  readonly deviationPct: number;
  readonly chainlinkPriceRaw: bigint;
  readonly twapPriceRaw: bigint;
  readonly twapFailureReason?: string;
  readonly failedHopIndex?: number;
}

export interface LiquidationOracleSanityResult {
  readonly pass: boolean;
  readonly debt: AssetOracleSanityDetail;
  readonly collateral: AssetOracleSanityDetail;
}

export interface EvaluateLiquidationOracleSanityInput {
  readonly chain: SupportedChain;
  readonly account: Address;
  readonly debtAsset: Address;
  readonly collateralAsset: Address;
  readonly primaryUsd8: (asset: Address) => Promise<bigint>;
  readonly resolveTwap: (asset: Address) => Promise<TwapUsdResult>;
  readonly thresholdPct?: number;
}

/**
 * Fail closed unless BOTH debt and collateral pass Chainlink↔compounded-TWAP
 * within threshold. Multi-hop TWAP failures on any hop surface as twap failure.
 */
export async function evaluateLiquidationOracleSanity(
  input: EvaluateLiquidationOracleSanityInput,
): Promise<LiquidationOracleSanityResult> {
  const thresholdPct = input.thresholdPct ?? ORACLE_SANITY_DEVIATION_THRESHOLD_PCT;
  const debt = await evaluateOneAsset({
    asset: input.debtAsset,
    role: "debt",
    primaryUsd8: input.primaryUsd8,
    resolveTwap: input.resolveTwap,
    thresholdPct,
  });
  const collateral = await evaluateOneAsset({
    asset: input.collateralAsset,
    role: "collateral",
    primaryUsd8: input.primaryUsd8,
    resolveTwap: input.resolveTwap,
    thresholdPct,
  });
  return {
    pass: debt.pass && collateral.pass,
    debt,
    collateral,
  };
}

async function evaluateOneAsset(input: {
  readonly asset: Address;
  readonly role: "debt" | "collateral";
  readonly primaryUsd8: (asset: Address) => Promise<bigint>;
  readonly resolveTwap: (asset: Address) => Promise<TwapUsdResult>;
  readonly thresholdPct: number;
}): Promise<AssetOracleSanityDetail> {
  const chainlinkPriceRaw = await input.primaryUsd8(input.asset);
  const twap = await input.resolveTwap(input.asset);
  if (!twap.ok) {
    return {
      asset: input.asset,
      role: input.role,
      pass: false,
      deviationPct: Number.POSITIVE_INFINITY,
      chainlinkPriceRaw,
      twapPriceRaw: 0n,
      twapFailureReason: twap.reason,
      ...(twap.failedHopIndex === undefined ? {} : { failedHopIndex: twap.failedHopIndex }),
    };
  }
  const result = evaluateOracleSanity({
    chain: "base",
    account: "0x0000000000000000000000000000000000000000",
    debtAsset: input.asset,
    collateralAsset: input.asset,
    chainlinkPriceRaw,
    twapPriceRaw: twap.priceUsd8,
    thresholdPct: input.thresholdPct,
    assetRole: input.role,
  });
  return {
    asset: input.asset,
    role: input.role,
    pass: result.pass,
    deviationPct: result.deviationPct,
    chainlinkPriceRaw,
    twapPriceRaw: twap.priceUsd8,
  };
}

export function createTwapResolver(
  client: ResolveTwapUsdInput["client"],
): (asset: Address) => Promise<TwapUsdResult> {
  return (asset) => resolveUniswapV3TwapUsd8({ client, asset });
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
    ...(input.assetRole === undefined ? {} : { assetRole: input.assetRole }),
    chainlinkPriceRaw: input.chainlinkPriceRaw.toString(),
    twapPriceRaw: input.twapPriceRaw.toString(),
    deviationPct: result.deviationPct,
    thresholdPct: input.thresholdPct ?? ORACLE_SANITY_DEVIATION_THRESHOLD_PCT,
  });
}

export function logLiquidationOracleSanityFailure(
  logger: LoggerLike,
  chain: SupportedChain,
  account: Address,
  result: LiquidationOracleSanityResult,
): void {
  logger.warn("oracle_sanity_deviation_block", {
    chain,
    account,
    pass: result.pass,
    debt: serializeDetail(result.debt),
    collateral: serializeDetail(result.collateral),
    thresholdPct: ORACLE_SANITY_DEVIATION_THRESHOLD_PCT,
  });
}

function serializeDetail(detail: AssetOracleSanityDetail): Record<string, unknown> {
  return {
    asset: detail.asset,
    role: detail.role,
    pass: detail.pass,
    deviationPct: detail.deviationPct,
    chainlinkPriceRaw: detail.chainlinkPriceRaw.toString(),
    twapPriceRaw: detail.twapPriceRaw.toString(),
    ...(detail.twapFailureReason === undefined ? {} : { twapFailureReason: detail.twapFailureReason }),
    ...(detail.failedHopIndex === undefined ? {} : { failedHopIndex: detail.failedHopIndex }),
  };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
