import { encodeFunctionData, type Address } from "viem";
import type { LiquidationCandidate } from "../protocols/aaveV3";
import { aavePoolAbi } from "../protocols/aaveV3";
import { encodeLiquidationRoute } from "../protocols/liquidationFlashLoanReceiver";
import type { SafeExecutionRequest } from "./safeTransactionExecutor";
import { createAssetAmount, type Asset } from "../utils/typedAssetMath";
import { getChainConfig } from "../config/chains";
import { calculateLiquidationEv } from "../utils/evCalculator";

const usdAsset: Asset = { symbol: "USD", decimals: 8 };

export interface LiquidationExecutionAdapterConfig {
  readonly account: Address;
  readonly minProfitUsd: number;
  readonly gasCostUsd: number;
  readonly slippageBps: number;
  readonly minimumMarginBps: number;
  readonly flashLoanReceiverAddress?: Address;
  readonly flashLoanReferralCode?: number;
}

export function buildLiquidationExecutionRequest(
  chain: "optimism" | "arbitrum" | "base",
  candidate: LiquidationCandidate,
  config: LiquidationExecutionAdapterConfig,
): SafeExecutionRequest {
  const economics = calculateLiquidationEv({
    repayValueUsd: candidate.repayValueUsd,
    liquidationBonusBps: candidate.liquidationBonusBps,
    gasCostUsd: config.gasCostUsd,
    slippageBps: config.slippageBps,
    minProfitUsd: config.minProfitUsd,
  });
  const revenue = usdRaw(candidate.repayValueUsd * (candidate.liquidationBonusBps / 10_000));
  const debt = usdRaw(candidate.repayValueUsd);
  const gas = usdRaw(config.gasCostUsd);
  const slippageBuffer = usdRaw((candidate.repayValueUsd * config.slippageBps) / 10_000);
  const safetyBuffer = usdRaw(config.minProfitUsd / 4);
  const pool = getChainConfig(chain).aave.pool;
  const capitalAtRisk = config.flashLoanReceiverAddress === undefined ? debt : gas;

  return {
    chain,
    account: config.account,
    opportunityId: `${chain}:${candidate.account}:${candidate.debtAsset}`,
    gasProfileKey: "aaveV3:flashLiquidation",
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
    buildTransaction: (route) => ({
      to: pool,
      data: config.flashLoanReceiverAddress === undefined
        ? encodeFunctionData({
          abi: aavePoolAbi,
          functionName: "liquidationCall",
          args: [
            candidate.collateralAsset,
            candidate.debtAsset,
            candidate.account,
            candidate.debtToCover,
            false,
          ],
        })
        : encodeFunctionData({
          abi: aavePoolAbi,
          functionName: "flashLoanSimple",
          args: [
            config.flashLoanReceiverAddress,
            candidate.debtAsset,
            candidate.debtToCover,
            encodeLiquidationRoute({
              collateralAsset: candidate.collateralAsset,
              debtAsset: candidate.debtAsset,
              user: candidate.account,
              debtToCover: candidate.debtToCover,
              receiveAToken: false,
            }),
            config.flashLoanReferralCode ?? 0,
          ],
        }),
      provider: route.provider,
    }),
  };
}

function usdRaw(value: number): ReturnType<typeof createAssetAmount> {
  const scaled = BigInt(Math.max(0, Math.round(value * 10 ** usdAsset.decimals)));
  return createAssetAmount(usdAsset, scaled);
}
