import { encodeFunctionData, type Address } from "viem";
import { MOONWELL_LIQUIDATOR_BONUS_BPS } from "../config/moonwellBase";
import { aavePoolAbi } from "../protocols/aaveV3";
import { encodeMoonwellRoute } from "../protocols/liquidationFlashLoanReceiver";
import { createAssetAmount, createAsset, type Asset } from "../utils/typedAssetMath";
import { estimateMinimumCollateralOut } from "./liquidationExecutionAdapter";
import type { SafeExecutionRequest } from "./safeTransactionExecutor";

const usdAsset: Asset = createAsset({ symbol: "USD", decimals: 8 });

export interface MoonwellLiquidationCandidate {
  readonly account: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly debtToCover: bigint;
  readonly repayValueUsd: number;
  readonly liquidationBonusBps: number;
}

export function buildMoonwellLiquidationExecutionRequest(input: {
  readonly chain: "base";
  readonly account: Address;
  readonly pool: Address;
  readonly receiver: Address;
  readonly referralCode?: number;
  readonly candidate: MoonwellLiquidationCandidate;
}): SafeExecutionRequest {
  const bonusBps = input.candidate.liquidationBonusBps > 0
    ? input.candidate.liquidationBonusBps
    : MOONWELL_LIQUIDATOR_BONUS_BPS;
  const minCollateralOut = estimateMinimumCollateralOut({
    account: input.candidate.account,
    collateralAsset: input.candidate.collateralAsset,
    debtAsset: input.candidate.debtAsset,
    debtToCover: input.candidate.debtToCover,
    repayValueUsd: input.candidate.repayValueUsd,
    liquidationBonusBps: bonusBps,
    healthFactor: 900_000_000_000_000_000n,
    closeFactorBps: 5_000,
  }, 50);
  const routeParams = encodeMoonwellRoute({
    collateralAsset: input.candidate.collateralAsset,
    debtAsset: input.candidate.debtAsset,
    user: input.candidate.account,
    debtToCover: input.candidate.debtToCover,
    minCollateralOut,
    receiveAToken: false,
  });
  return {
    chain: input.chain,
    account: input.account,
    opportunityId: `${input.chain}:moonwell:${input.candidate.account}:${input.candidate.debtAsset}`,
    gasProfileKey: `moonwell:${input.candidate.collateralAsset.toLowerCase()}:${input.candidate.debtAsset.toLowerCase()}`,
    routeInput: {
      chain: input.chain,
      opportunityId: `${input.chain}:moonwell:${input.candidate.account}:${input.candidate.debtAsset}`,
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
