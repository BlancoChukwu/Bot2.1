import { encodeFunctionData, type Address } from "viem";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import { aavePoolAbi } from "../protocols/aaveV3";
import { encodeLiquidationRoute } from "../protocols/liquidationFlashLoanReceiver";
import type { SafeExecutionRequest } from "./safeTransactionExecutor";
import { createAssetAmount, type Asset } from "../utils/typedAssetMath";
import { getChainConfig } from "../config/chains";
import { defaultCloseFactorBps, resolveAavePoolVersion } from "../config/aavePoolVersion";
import { AAVE_V3_BASE_FLASH_FEE_BPS, calculateFlashWrappedLiquidationEv } from "../utils/evCalculator";
import type { RouteSelectionResult } from "../profitability/flashLoanProviderRouter";

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
}

type SelectedRoute = Extract<RouteSelectionResult, { readonly status: "selected" }>;

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
  const minCollateralOut = estimateMinimumCollateralOut(candidate, effectiveSlippageBps);
  const routeParams = encodeLiquidationRoute({
    collateralAsset: candidate.collateralAsset,
    debtAsset: candidate.debtAsset,
    user: candidate.account,
    debtToCover: candidate.debtToCover,
    minCollateralOut,
    receiveAToken: false,
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

function usdRaw(value: number): ReturnType<typeof createAssetAmount> {
  const scaled = BigInt(Math.max(0, Math.round(value * 10 ** usdAsset.decimals)));
  return createAssetAmount(usdAsset, scaled);
}
