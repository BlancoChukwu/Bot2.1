import type { Address } from "viem";
import type { PriceOracleCache } from "./priceOracleCache";

export interface LiquidationEvInput {
  readonly repayValueUsd: number;
  readonly liquidationBonusBps: number;
  readonly gasCostUsd: number;
  readonly slippageBps: number;
  readonly minProfitUsd: number;
}

export interface LiquidationEv {
  readonly expectedProfitUsd: number;
  readonly isProfitable: boolean;
}

export interface LiquidationEV {
  readonly profitWei: bigint;
  readonly rawProfitWei: bigint;
  readonly gasCostWei: bigint;
  readonly slippageBufferWei: bigint;
  readonly isProfitable: boolean;
}

export const MIN_PROFIT_THRESHOLD_WEI = 10_000_000_000_000_000n;
export const MIN_PROFIT_THRESHOLD_BNB = 150_000_000_000_000_000n;
export const AAVE_V3_BASE_FLASH_FEE_BPS = 5;

const bpsDenominator = 10_000;
const bpsDenominatorWei = 10_000n;
const defaultSlippageBufferBps = 100n;

export function calculateLiquidationEV(
  debtToCover: bigint,
  collateralReceived: bigint,
  bonusPercentage: number,
  gasEstimate: bigint,
  gasPrice: bigint,
  minProfitThreshold = MIN_PROFIT_THRESHOLD_WEI,
): LiquidationEV {
  assertNonNegativeBigint("debtToCover", debtToCover);
  assertNonNegativeBigint("collateralReceived", collateralReceived);
  assertNonNegativeBigint("gasEstimate", gasEstimate);
  assertNonNegativeBigint("gasPrice", gasPrice);
  assertNonNegativeBigint("minProfitThreshold", minProfitThreshold);
  assertNonNegative("bonusPercentage", bonusPercentage);

  const bonusWei = (collateralReceived * BigInt(Math.trunc(bonusPercentage))) / bpsDenominatorWei;
  const gasCostWei = gasEstimate * gasPrice;
  const slippageBufferWei = (collateralReceived * defaultSlippageBufferBps) / bpsDenominatorWei;
  const rawProfitWei = bonusWei - gasCostWei - slippageBufferWei;
  const isProfitable = rawProfitWei >= minProfitThreshold;

  // Kelly sizing belongs at the capital allocator layer: cap exposure per liquidation
  // to protect the hot wallet from correlated bad fills and stale price assumptions.
  return {
    profitWei: isProfitable ? rawProfitWei : 0n,
    rawProfitWei,
    gasCostWei,
    slippageBufferWei,
    isProfitable,
  };
}

export function calculateLiquidationEv(input: LiquidationEvInput): LiquidationEv {
  assertNonNegative("repayValueUsd", input.repayValueUsd);
  assertNonNegative("liquidationBonusBps", input.liquidationBonusBps);
  assertNonNegative("gasCostUsd", input.gasCostUsd);
  assertNonNegative("slippageBps", input.slippageBps);
  assertNonNegative("minProfitUsd", input.minProfitUsd);

  const bonusUsd = input.repayValueUsd * (input.liquidationBonusBps / bpsDenominator);
  const slippageUsd = input.repayValueUsd * (input.slippageBps / bpsDenominator);
  const expectedProfitUsd = bonusUsd - input.gasCostUsd - slippageUsd;

  return {
    expectedProfitUsd,
    isProfitable: expectedProfitUsd >= input.minProfitUsd,
  };
}

export interface FlashLoanArbitrageInput {
  readonly amountIn: bigint;
  readonly amountOutFinal: bigint;
  readonly flashFeeBps: number;
  readonly gasEstimate: bigint;
  readonly gasPrice: bigint;
  readonly slippageBps?: number;
  readonly minProfitThreshold?: bigint;
}

export interface FlashLoanArbitrageEV {
  readonly profitWei: bigint;
  readonly rawProfitWei: bigint;
  readonly flashFeeWei: bigint;
  readonly gasCostWei: bigint;
  readonly slippageBufferWei: bigint;
  readonly isProfitable: boolean;
}

export function calculateFlashLoanArbitrageEV(input: FlashLoanArbitrageInput): FlashLoanArbitrageEV {
  const {
    amountIn,
    amountOutFinal,
    flashFeeBps,
    gasEstimate,
    gasPrice,
    slippageBps = Number(defaultSlippageBufferBps),
    minProfitThreshold = MIN_PROFIT_THRESHOLD_WEI,
  } = input;

  assertNonNegativeBigint("amountIn", amountIn);
  assertNonNegativeBigint("amountOutFinal", amountOutFinal);
  assertNonNegativeBigint("gasEstimate", gasEstimate);
  assertNonNegativeBigint("gasPrice", gasPrice);
  assertNonNegativeBigint("minProfitThreshold", minProfitThreshold);
  assertNonNegative("flashFeeBps", flashFeeBps);
  assertNonNegative("slippageBps", slippageBps);

  const flashFeeWei = (amountIn * BigInt(Math.trunc(flashFeeBps))) / bpsDenominatorWei;
  const gasCostWei = gasEstimate * gasPrice;
  const slippageBufferWei = (amountOutFinal * BigInt(Math.trunc(slippageBps))) / bpsDenominatorWei;
  const rawProfitWei = amountOutFinal - amountIn - flashFeeWei - gasCostWei - slippageBufferWei;
  const isProfitable = rawProfitWei >= minProfitThreshold;

  return {
    profitWei: isProfitable ? rawProfitWei : 0n,
    rawProfitWei,
    flashFeeWei,
    gasCostWei,
    slippageBufferWei,
    isProfitable,
  };
}

export interface ExactUsdEVInput extends FlashLoanArbitrageInput {
  readonly tokenIn: Address;
  readonly tokenInDecimals: number;
  readonly nativeGasToken: Address;
  readonly nativeGasTokenDecimals?: number;
  readonly minProfitUsdRaw?: bigint;
}

export interface ExactUsdEV {
  readonly netProfitUsdRaw: bigint;
  readonly revenueUsdRaw: bigint;
  readonly costUsdRaw: bigint;
  readonly isPriceAvailable: boolean;
  readonly isProfitable: boolean;
}

export async function calculateExactUsdEV(
  input: ExactUsdEVInput,
  priceCache: Pick<PriceOracleCache, "batchGetUsdPrices">,
): Promise<ExactUsdEV> {
  assertNonNegativeBigint("amountIn", input.amountIn);
  assertNonNegativeBigint("amountOutFinal", input.amountOutFinal);
  assertNonNegative("tokenInDecimals", input.tokenInDecimals);
  if (!Number.isInteger(input.tokenInDecimals)) {
    throw new Error("tokenInDecimals must be an integer");
  }

  const threshold = input.minProfitUsdRaw ?? 15_000_000n;
  assertNonNegativeBigint("minProfitUsdRaw", threshold);
  const nativeGasTokenDecimals = input.nativeGasTokenDecimals ?? 18;
  assertNonNegative("nativeGasTokenDecimals", nativeGasTokenDecimals);
  if (!Number.isInteger(nativeGasTokenDecimals)) {
    throw new Error("nativeGasTokenDecimals must be an integer");
  }

  const prices = await priceCache.batchGetUsdPrices([input.tokenIn, input.nativeGasToken]);
  const tokenInUsdPriceRaw = prices[input.tokenIn] ?? 0n;
  const nativeGasUsdPriceRaw = prices[input.nativeGasToken] ?? 0n;
  if (tokenInUsdPriceRaw <= 0n || nativeGasUsdPriceRaw <= 0n) {
    return {
      netProfitUsdRaw: 0n,
      revenueUsdRaw: 0n,
      costUsdRaw: 0n,
      isPriceAvailable: false,
      isProfitable: false,
    };
  }

  const ev = calculateFlashLoanArbitrageEV(input);
  const revenueUsdRaw = tokenAmountToUsdRaw(
    input.amountOutFinal,
    input.tokenInDecimals,
    tokenInUsdPriceRaw,
  );
  const costTokenRaw = input.amountIn + ev.flashFeeWei + ev.slippageBufferWei;
  const costUsdRaw = tokenAmountToUsdRaw(costTokenRaw, input.tokenInDecimals, tokenInUsdPriceRaw) + weiToUsdRaw(
    ev.gasCostWei,
    nativeGasUsdPriceRaw,
    nativeGasTokenDecimals,
  );

  const netProfitUsdRaw = revenueUsdRaw - costUsdRaw;
  return {
    netProfitUsdRaw,
    revenueUsdRaw,
    costUsdRaw,
    isPriceAvailable: true,
    isProfitable: netProfitUsdRaw >= threshold,
  };
}

export interface FullFlashLoanSimulationClient {
  call(args: Record<string, unknown>): Promise<unknown>;
  estimateGas?(args: Record<string, unknown>): Promise<bigint>;
}

export interface FullFlashLoanSimulationInput {
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
  readonly from: `0x${string}`;
  readonly gasPrice: bigint;
}

export interface FullFlashLoanSimulationResult {
  readonly success: boolean;
  readonly gasUsed: bigint;
  readonly error?: string;
}

export async function simulateFullFlashLoanArbPath(
  client: FullFlashLoanSimulationClient,
  input: FullFlashLoanSimulationInput,
): Promise<FullFlashLoanSimulationResult> {
  const callArgs = {
    account: input.from,
    to: input.to,
    data: input.data,
    gasPrice: input.gasPrice,
  };

  try {
    await client.call(callArgs);
    const gasUsed = client.estimateGas === undefined ? 0n : await estimateGasSafely(client, callArgs);
    return { success: true, gasUsed };
  } catch (error) {
    return {
      success: false,
      gasUsed: 0n,
      error: toErrorMessage(error),
    };
  }
}

async function estimateGasSafely(
  client: Pick<FullFlashLoanSimulationClient, "estimateGas">,
  args: Record<string, unknown>,
): Promise<bigint> {
  try {
    const estimated = await client.estimateGas?.(args);
    return estimated ?? 0n;
  } catch {
    return 0n;
  }
}

function assertNonNegativeBigint(name: string, value: bigint): void {
  if (value < 0n) {
    throw new Error(`${name} must be a non-negative bigint`);
  }
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function tokenAmountToUsdRaw(amountRaw: bigint, tokenDecimals: number, tokenUsdPriceRaw: bigint): bigint {
  return (amountRaw * tokenUsdPriceRaw) / 10n ** BigInt(tokenDecimals);
}

function weiToUsdRaw(weiAmount: bigint, nativeUsdPriceRaw: bigint, nativeTokenDecimals: number): bigint {
  return (weiAmount * nativeUsdPriceRaw) / 10n ** BigInt(nativeTokenDecimals);
}
