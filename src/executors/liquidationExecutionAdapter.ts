import { encodeFunctionData, type Address } from "viem";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import { aavePoolAbi } from "../protocols/aaveV3";
import {
  encodeLiquidationRoute,
  type UniswapV3FeeTier,
} from "../protocols/liquidationFlashLoanReceiver";
import type { SafeExecutionRequest } from "./safeTransactionExecutor";
import { createAssetAmount, type Asset } from "../utils/typedAssetMath";
import { getChainConfig } from "../config/chains";
import { defaultCloseFactorBps, resolveAavePoolVersion } from "../config/aavePoolVersion";
import { AAVE_V3_BASE_FLASH_FEE_BPS, calculateFlashWrappedLiquidationEv } from "../utils/evCalculator";
import type { RouteSelectionResult } from "../profitability/flashLoanProviderRouter";
import type { QuoteEngine } from "../mirror/quoteEngine";
import type { DexConfig } from "../monitors/arbitrageScanner";

const usdAsset: Asset = { symbol: "USD", decimals: 8 };
const balancerVault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const balancerVaultAbi = [
  {
    type: "function",
    name: "flashLoan",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface LiquidationExecutionAdapterConfig {
  readonly account: Address;
  readonly minProfitUsd: number;
  readonly gasCostUsd: number;
  readonly slippageBps: number;
  readonly minimumMarginBps: number;
  readonly flashLoanReceiverAddress?: Address;
  readonly flashLoanReferralCode?: number;
  readonly requireFlashLoanWrapper?: boolean;
  readonly flashFeeBps?: number;
  readonly slippageBufferFloorBps?: number;
  readonly poolAddress?: Address;
  /**
   * Advisory field 6 only (debt-asset wei). Prefer `estimateMinimumDebtOut` (quote-based).
   * On-chain amountOutMinimum is the Aave-oracle floor — never this value.
   */
  readonly advisoryMinDebtOut?: bigint;
  /** Uniswap V3 fee tier encoded as route field 8 (default 3000). */
  readonly swapFee?: UniswapV3FeeTier;
}

type SelectedRoute = Extract<RouteSelectionResult, { readonly status: "selected" }>;

interface ReadOnlyClient {
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

export interface EstimateMinimumDebtOutInput {
  readonly candidate: LiquidationCandidate;
  readonly slippageBps: number;
  readonly fee: UniswapV3FeeTier;
  readonly quoteEngine: QuoteEngine;
  readonly client: ReadOnlyClient;
  readonly dex: DexConfig;
  /**
   * Collateral wei sold on the swap (amountIn). Defaults to `candidate.collateralReceivedWei`.
   * Required for a real quote — debtToCover alone cannot invent collateral wei.
   */
  readonly collateralAmountIn?: bigint;
}

const BPS = 10_000n;

/** Raw Quoter amountOut (debt-asset wei). No slippage haircut. */
export async function quoteExactDebtOut(input: EstimateMinimumDebtOutInput): Promise<bigint> {
  const amountIn = resolveCollateralAmountIn(input);
  if (amountIn <= 0n) {
    return 0n;
  }
  return input.quoteEngine.quoteExactInputSingle(
    input.client,
    input.dex,
    input.candidate.collateralAsset,
    input.candidate.debtAsset,
    amountIn,
    input.fee,
  );
}

/** Pure quote haircut — no min(quote, need) / no repay-cap collapse. */
export function haircutQuotedDebtOut(quotedDebtOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  const haircut = (quotedDebtOut * BigInt(slippageBps)) / BPS;
  return quotedDebtOut > haircut ? quotedDebtOut - haircut : 0n;
}

/**
 * Off-chain profitability / candidate-filter preview only.
 * Quote-based (QuoteEngine.quoteExactInputSingle) and **debt-asset denominated**.
 * Must NOT be used as Uniswap amountOutMinimum — the receiver computes that on-chain
 * from actual collateralBal via Aave's price oracle (Option B / B1).
 * Never min() against flash repay need — that collapses the floor on profitable liquidations.
 */
export async function estimateMinimumDebtOut(input: EstimateMinimumDebtOutInput): Promise<bigint> {
  if (input.slippageBps < 0 || input.slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range: ${input.slippageBps}`);
  }
  const quotedDebtOut = await quoteExactDebtOut(input);
  return haircutQuotedDebtOut(quotedDebtOut, input.slippageBps);
}

/**
 * Off-chain replica of LiquidationFlashReceiver._oracleMinDebtOut (integer only).
 * Prices must share one scale on both legs (Aave base-8 or LocalPositionModel wad18).
 */
export function computeOracleMinDebtOut(input: {
  readonly collateralBal: bigint;
  readonly priceCollateral: bigint;
  readonly priceDebt: bigint;
  readonly collateralDecimals: number;
  readonly debtDecimals: number;
  readonly swapSlippageBps: number;
}): bigint {
  if (input.priceCollateral <= 0n || input.priceDebt <= 0n) {
    throw new Error("invalid_oracle_price");
  }
  if (input.swapSlippageBps < 0 || input.swapSlippageBps >= 10_000) {
    throw new Error(`swapSlippageBps out of range: ${input.swapSlippageBps}`);
  }
  const fairDebtOut =
    (input.collateralBal * input.priceCollateral * (10n ** BigInt(input.debtDecimals)))
    / (input.priceDebt * (10n ** BigInt(input.collateralDecimals)));
  let floor = (fairDebtOut * (BPS - BigInt(input.swapSlippageBps))) / BPS;
  if (floor === 0n && fairDebtOut > 0n) {
    floor = 1n;
  }
  return floor;
}

/** Soft buffer applied after the on-chain-equivalent floor (not folded into swapSlippageBps). */
export function applyQuoteGateBuffer(floor: bigint, quoteGateBufferBps: number): bigint {
  if (quoteGateBufferBps < 0 || quoteGateBufferBps >= 10_000) {
    throw new Error(`quoteGateBufferBps out of range: ${quoteGateBufferBps}`);
  }
  return (floor * (BPS - BigInt(quoteGateBufferBps))) / BPS;
}

export type QuoteFloorGateEvaluation =
  | { readonly status: "pass"; readonly floor: bigint; readonly minAcceptable: bigint; readonly quotedOut: bigint }
  | { readonly status: "reject"; readonly floor: bigint; readonly minAcceptable: bigint; readonly quotedOut: bigint }
  | { readonly status: "unavailable"; readonly reason: "missing_price_or_decimals" };

/**
 * Compare raw Quoter output to oracle floor × buffer.
 * Missing cache inputs → unavailable (caller must fail-open).
 */
export function evaluateQuoteFloorGate(input: {
  readonly quotedOut: bigint;
  readonly collateralBal: bigint;
  readonly priceCollateral: bigint | undefined;
  readonly priceDebt: bigint | undefined;
  readonly collateralDecimals: number | undefined;
  readonly debtDecimals: number | undefined;
  readonly swapSlippageBps: number;
  readonly quoteGateBufferBps: number;
}): QuoteFloorGateEvaluation {
  if (
    input.priceCollateral === undefined
    || input.priceDebt === undefined
    || input.priceCollateral <= 0n
    || input.priceDebt <= 0n
    || input.collateralDecimals === undefined
    || input.debtDecimals === undefined
  ) {
    return { status: "unavailable", reason: "missing_price_or_decimals" };
  }
  const floor = computeOracleMinDebtOut({
    collateralBal: input.collateralBal,
    priceCollateral: input.priceCollateral,
    priceDebt: input.priceDebt,
    collateralDecimals: input.collateralDecimals,
    debtDecimals: input.debtDecimals,
    swapSlippageBps: input.swapSlippageBps,
  });
  const minAcceptable = applyQuoteGateBuffer(floor, input.quoteGateBufferBps);
  if (input.quotedOut < minAcceptable) {
    return { status: "reject", floor, minAcceptable, quotedOut: input.quotedOut };
  }
  return { status: "pass", floor, minAcceptable, quotedOut: input.quotedOut };
}

export type QuoteFloorGatePhaseResult =
  | {
    readonly outcome: "reject";
    readonly quotedOut: bigint;
    readonly floor: bigint;
    readonly minAcceptable: bigint;
  }
  | {
    readonly outcome: "pass";
    readonly quotedOut: bigint;
    readonly floor: bigint;
    readonly minAcceptable: bigint;
    readonly advisoryMinDebtOut: bigint;
  }
  | {
    readonly outcome: "unavailable";
    readonly reason: string;
    readonly advisoryMinDebtOut: bigint;
  };

/**
 * Quote then evaluate the oracle-floor gate. Quote RPC failure → unavailable (fail-open).
 */
export async function runQuoteFloorGatePhase(input: {
  readonly quote: () => Promise<bigint>;
  readonly collateralBal: bigint;
  readonly priceCollateral: bigint | undefined;
  readonly priceDebt: bigint | undefined;
  readonly collateralDecimals: number | undefined;
  readonly debtDecimals: number | undefined;
  readonly swapSlippageBps: number;
  readonly quoteGateBufferBps: number;
  readonly advisorySlippageBps: number;
}): Promise<QuoteFloorGatePhaseResult> {
  let quotedOut: bigint;
  try {
    quotedOut = await input.quote();
  } catch (error) {
    return {
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      advisoryMinDebtOut: 0n,
    };
  }
  const gate = evaluateQuoteFloorGate({
    quotedOut,
    collateralBal: input.collateralBal,
    priceCollateral: input.priceCollateral,
    priceDebt: input.priceDebt,
    collateralDecimals: input.collateralDecimals,
    debtDecimals: input.debtDecimals,
    swapSlippageBps: input.swapSlippageBps,
    quoteGateBufferBps: input.quoteGateBufferBps,
  });
  if (gate.status === "unavailable") {
    return {
      outcome: "unavailable",
      reason: gate.reason,
      advisoryMinDebtOut: haircutQuotedDebtOut(quotedOut, input.advisorySlippageBps),
    };
  }
  if (gate.status === "reject") {
    return {
      outcome: "reject",
      quotedOut: gate.quotedOut,
      floor: gate.floor,
      minAcceptable: gate.minAcceptable,
    };
  }
  return {
    outcome: "pass",
    quotedOut: gate.quotedOut,
    floor: gate.floor,
    minAcceptable: gate.minAcceptable,
    advisoryMinDebtOut: haircutQuotedDebtOut(quotedOut, input.advisorySlippageBps),
  };
}

/**
 * @deprecated Use estimateMinimumDebtOut (quote-based, debt-asset wei). Kept for call-site migration.
 * This bonus/close-factor heuristic is NOT a Uniswap quote and MUST NOT drive amountOutMinimum.
 */
export function estimateMinimumCollateralOut(candidate: LiquidationCandidate, slippageBps: number): bigint {
  const poolVersion = resolveAavePoolVersion();
  const effectiveCloseFactorBps = candidate.closeFactorBps
    ?? defaultCloseFactorBps(poolVersion, candidate.healthFactor);
  const bonusBps = candidate.effectiveLiquidationBonusBps ?? candidate.liquidationBonusBps;
  const debtCovered = (candidate.debtToCover * BigInt(effectiveCloseFactorBps)) / 10_000n;
  const grossCollateral = debtCovered + (debtCovered * BigInt(bonusBps)) / 10_000n;
  const haircut = (grossCollateral * BigInt(slippageBps)) / 10_000n;
  return grossCollateral > haircut ? grossCollateral - haircut : 0n;
}

export function buildLiquidationExecutionRequest(
  chain: "optimism" | "arbitrum" | "base",
  candidate: LiquidationCandidate,
  config: LiquidationExecutionAdapterConfig,
): SafeExecutionRequest {
  const effectiveSlippageBps = Math.max(config.slippageBps, config.slippageBufferFloorBps ?? 500);
  const flashFeeBps = config.flashFeeBps ?? AAVE_V3_BASE_FLASH_FEE_BPS;
  const economics = calculateFlashWrappedLiquidationEv({
    repayValueUsd: candidate.repayValueUsd,
    liquidationBonusBps: candidate.liquidationBonusBps,
    gasCostUsd: config.gasCostUsd,
    slippageBps: effectiveSlippageBps,
    minProfitUsd: config.minProfitUsd,
    flashFeeBps,
  });
  void economics;
  const revenue = usdRaw(candidate.repayValueUsd * (candidate.liquidationBonusBps / 10_000));
  const debt = usdRaw(candidate.repayValueUsd);
  const gas = usdRaw(config.gasCostUsd);
  const slippageBuffer = usdRaw((candidate.repayValueUsd * effectiveSlippageBps) / 10_000);
  const safetyBuffer = usdRaw(config.minProfitUsd / 4);
  const pool = config.poolAddress ?? getChainConfig(chain).aave.pool;
  if ((config.requireFlashLoanWrapper ?? false) && config.flashLoanReceiverAddress === undefined) {
    throw new Error("flashLoanReceiverAddress is required when flash-loan wrapper enforcement is enabled");
  }
  const receiver = config.flashLoanReceiverAddress;
  const capitalAtRisk = config.flashLoanReceiverAddress === undefined ? debt : gas;
  // Field 6: advisory only. Prefer quote-based estimateMinimumDebtOut upstream.
  // On-chain amountOutMinimum is the Aave-oracle floor over actual collateralBal (v5).
  const minDebtOut = config.advisoryMinDebtOut ?? 0n;
  const swapFee = config.swapFee ?? 3_000;
  const routeParams = encodeLiquidationRoute({
    collateralAsset: candidate.collateralAsset,
    debtAsset: candidate.debtAsset,
    user: candidate.account,
    debtToCover: candidate.debtToCover,
    minDebtOut,
    receiveAToken: false,
    fee: swapFee,
  });

  return {
    chain,
    account: config.account,
    opportunityId: `${chain}:${candidate.account}:${candidate.debtAsset}`,
    gasProfileKey: `liq:${candidate.collateralAsset.toLowerCase()}:${candidate.debtAsset.toLowerCase()}`,
    gasLimitHint: {
      collateralAsset: candidate.collateralAsset,
      debtAsset: candidate.debtAsset,
      usesFlashWrapper: config.flashLoanReceiverAddress !== undefined,
    },
    routeInput: {
      chain,
      opportunityId: `${chain}:${candidate.account}:${candidate.debtAsset}`,
      revenue,
      debt,
      gas,
      swapCost: usdRaw(0),
      slippageBuffer,
      safetyBuffer,
      capitalAtRisk,
      minimumMarginBps: config.minimumMarginBps,
    },
    buildTransaction: (route) => config.flashLoanReceiverAddress === undefined
      ? {
        to: pool,
        data: encodeFunctionData({
          abi: aavePoolAbi,
          functionName: "liquidationCall",
          args: [
            candidate.collateralAsset,
            candidate.debtAsset,
            candidate.account,
            candidate.debtToCover,
            false,
          ],
        }),
        contractCall: {
          abi: aavePoolAbi,
          functionName: "liquidationCall",
          args: [
            candidate.collateralAsset,
            candidate.debtAsset,
            candidate.account,
            candidate.debtToCover,
            false,
          ] as const,
        },
        provider: route.provider,
      }
      : toFlashWrappedEnvelope(route, {
        pool,
        receiver: receiver!,
        debtAsset: candidate.debtAsset,
        debtToCover: candidate.debtToCover,
        routeParams,
        referralCode: config.flashLoanReferralCode ?? 0,
      }),
    ...(config.flashLoanReceiverAddress === undefined
      ? {}
      : {
        buildFlashLoanPreviewTransaction: (route: SelectedRoute) => toFlashWrappedEnvelope(route, {
          pool,
          receiver: receiver!,
          debtAsset: candidate.debtAsset,
          debtToCover: candidate.debtToCover,
          routeParams,
          referralCode: config.flashLoanReferralCode ?? 0,
        }),
      }),
  };
}

function resolveCollateralAmountIn(input: EstimateMinimumDebtOutInput): bigint {
  if (input.collateralAmountIn !== undefined && input.collateralAmountIn > 0n) {
    return input.collateralAmountIn;
  }
  if (input.candidate.collateralReceivedWei !== undefined && input.candidate.collateralReceivedWei > 0n) {
    return input.candidate.collateralReceivedWei;
  }
  return 0n;
}

function toFlashWrappedEnvelope(
  route: SelectedRoute,
  config: {
    readonly pool: Address;
    readonly receiver: Address;
    readonly debtAsset: Address;
    readonly debtToCover: bigint;
    readonly routeParams: `0x${string}`;
    readonly referralCode: number;
  },
) {
  if (route.provider === "balancer") {
    return {
      to: balancerVault as Address,
      data: encodeFunctionData({
        abi: balancerVaultAbi,
        functionName: "flashLoan",
        args: [
          config.receiver,
          [config.debtAsset],
          [config.debtToCover],
          config.routeParams,
        ],
      }),
      contractCall: {
        abi: balancerVaultAbi,
        functionName: "flashLoan",
        args: [
          config.receiver,
          [config.debtAsset],
          [config.debtToCover],
          config.routeParams,
        ] as const,
      },
      provider: route.provider,
    };
  }
  return {
    to: config.pool,
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "flashLoanSimple",
      args: [
        config.receiver,
        config.debtAsset,
        config.debtToCover,
        config.routeParams,
        config.referralCode,
      ],
    }),
    contractCall: {
      abi: aavePoolAbi,
      functionName: "flashLoanSimple",
      args: [
        config.receiver,
        config.debtAsset,
        config.debtToCover,
        config.routeParams,
        config.referralCode,
      ] as const,
    },
    provider: route.provider,
  };
}

function usdRaw(value: number): ReturnType<typeof createAssetAmount> {
  const scaled = BigInt(Math.max(0, Math.round(value * 10 ** usdAsset.decimals)));
  return createAssetAmount(usdAsset, scaled);
}
