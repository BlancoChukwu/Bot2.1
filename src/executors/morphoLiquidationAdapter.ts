import { encodeFunctionData, type Address } from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";
import { encodeMorphoRoute } from "../protocols/liquidationFlashLoanReceiver";
import type { SafeExecutionRequest } from "./safeTransactionExecutor";
import { createAssetAmount, createAsset, type Asset } from "../utils/typedAssetMath";

const usdAsset: Asset = createAsset({ symbol: "USD", decimals: 8 });

export interface MorphoLiquidationCandidate {
  readonly account: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly debtToCover: bigint;
  readonly repayValueUsd: number;
}

export function buildMorphoLiquidationExecutionRequest(input: {
  readonly chain: "base";
  readonly account: Address;
  readonly pool: Address;
  readonly receiver: Address;
  readonly referralCode?: number;
  readonly candidate: MorphoLiquidationCandidate;
}): SafeExecutionRequest {
  const routeParams = encodeMorphoRoute({
    collateralAsset: input.candidate.collateralAsset,
    debtAsset: input.candidate.debtAsset,
    user: input.candidate.account,
    debtToCover: input.candidate.debtToCover,
    minCollateralOut: 1n,
    receiveAToken: false,
  });
  return {
    chain: input.chain,
    account: input.account,
    opportunityId: `${input.chain}:morpho:${input.candidate.account}:${input.candidate.debtAsset}`,
    gasProfileKey: `morpho:${input.candidate.collateralAsset.toLowerCase()}:${input.candidate.debtAsset.toLowerCase()}`,
    routeInput: {
      chain: input.chain,
      opportunityId: `${input.chain}:morpho:${input.candidate.account}:${input.candidate.debtAsset}`,
      revenue: createAssetAmount(usdAsset, BigInt(Math.max(0, Math.round(input.candidate.repayValueUsd * 1e8)))),
      debt: createAssetAmount(usdAsset, BigInt(Math.max(0, Math.round(input.candidate.repayValueUsd * 1e8)))),
      gas: createAssetAmount(usdAsset, 25_000_000n),
      swapCost: createAssetAmount(usdAsset, 0n),
      slippageBuffer: createAssetAmount(usdAsset, 10_000_000n),
      safetyBuffer: createAssetAmount(usdAsset, 5_000_000n),
      capitalAtRisk: createAssetAmount(usdAsset, 25_000_000n),
      minimumMarginBps: 50,
    },
    buildTransaction: (route) => ({
      to: input.pool,
      data: encodeFunctionData({
        abi: aavePoolAbi,
        functionName: "flashLoanSimple",
        args: [input.receiver, input.candidate.debtAsset, input.candidate.debtToCover, routeParams, input.referralCode ?? 0],
      }),
      provider: route.provider,
    }),
  };
}

