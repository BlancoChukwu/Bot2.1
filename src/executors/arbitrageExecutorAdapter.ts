import { encodeFunctionData, type Address } from "viem";
import type { ArbitrageOpportunity } from "../monitors/arbitrageScanner";
import { aavePoolAbi } from "../protocols/aaveV3";
import { encodeArbitrageRoute } from "../protocols/arbitrageFlashLoanReceiver";
import type { SafeExecutionRequest } from "./safeTransactionExecutor";
import { createAssetAmount, type Asset } from "../utils/typedAssetMath";
import type { FlashLoanProviderId } from "../config/chainRegistry";
const usdAsset: Asset = { symbol: "USD", decimals: 8 };

export interface ArbitrageExecutionAdapterConfig {
  readonly receiverAddress: Address;
  readonly operatorAddress: Address;
  readonly referralCode?: number;
  readonly gasProfileKey?: string;
}

export function buildArbitrageExecutionRequest(
  opportunity: ArbitrageOpportunity,
  config: ArbitrageExecutionAdapterConfig,
): SafeExecutionRequest {
  const encodedParams = encodeArbitrageRoute({
    buyRouter: opportunity.buyDex.router,
    sellRouter: opportunity.sellDex.router,
    tokenIn: opportunity.tokenIn,
    tokenOut: opportunity.tokenOut,
    amountIn: opportunity.amountIn,
    minBuyOut: opportunity.expectedIntermediateOut,
    minSellOut: minAmountOut(opportunity.expectedAmountOut, opportunity.minimumMarginBps),
  });
  return {
    chain: opportunity.chain,
    account: config.operatorAddress,
    opportunityId: opportunity.opportunityId,
    gasProfileKey: config.gasProfileKey ?? "arb:flashLoanSimple",
    routeInput: {
      chain: opportunity.chain,
      opportunityId: opportunity.opportunityId,
      revenue: createAssetAmount(usdAsset, opportunity.expectedRevenue.raw),
      debt: createAssetAmount(usdAsset, opportunity.capitalAtRisk.raw),
      gas: opportunity.estimatedGas,
      swapCost: createAssetAmount(usdAsset, 0n),
      slippageBuffer: createAssetAmount(usdAsset, opportunity.slippageBuffer.raw),
      safetyBuffer: createAssetAmount(usdAsset, opportunity.safetyBuffer.raw),
      capitalAtRisk: createAssetAmount(usdAsset, opportunity.capitalAtRisk.raw),
      minimumMarginBps: opportunity.minimumMarginBps,
    },
    buildTransaction: (route) => ({
      to: aavePoolAddress(opportunity),
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "flashLoanSimple",
        args: [
          config.receiverAddress,
          opportunity.tokenIn,
          opportunity.amountIn,
          encodedParams,
          config.referralCode ?? 0,
        ],
      }),
      provider: route.provider as FlashLoanProviderId,
    }),
  };
}

function minAmountOut(expectedOut: bigint, minimumMarginBps: number): bigint {
  const bps = 10_000n - BigInt(Math.min(Math.max(minimumMarginBps, 0), 9_500));
  return (expectedOut * bps) / 10_000n;
}

function aavePoolAddress(opportunity: ArbitrageOpportunity): Address {
  // The pool address is constant across supported chains in this repo.
  return opportunity.chain === "base"
    ? "0x794a61358d6845594f94dc1db02a252b5b4814ad"
    : "0x794a61358d6845594f94dc1db02a252b5b4814ad";
}
