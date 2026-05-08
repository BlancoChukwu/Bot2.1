import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { buildArbitrageExecutionRequest } from "../../src/executors/arbitrageExecutorAdapter";
import { aavePoolAbi } from "../../src/protocols/aaveV3";
import type { ArbitrageOpportunity } from "../../src/monitors/arbitrageScanner";
import { createAssetAmount } from "../../src/utils/typedAssetMath";

function opportunity(): ArbitrageOpportunity {
  const usd = { symbol: "USD", decimals: 8 } as const;
  const usdc = { symbol: "USDC", decimals: 6 } as const;
  return {
    chain: "base",
    opportunityId: "arb:base:1",
    buyDex: { name: "buy", router: "0x1111111111111111111111111111111111111111", feeBps: 30 },
    sellDex: { name: "sell", router: "0x2222222222222222222222222222222222222222", feeBps: 30 },
    tokenIn: "0x3333333333333333333333333333333333333333",
    tokenOut: "0x4444444444444444444444444444444444444444",
    amountIn: 1_000_000n,
    expectedAmountOut: 1_050_000n,
    expectedRevenue: createAssetAmount(usdc, 50_000n),
    estimatedGas: createAssetAmount(usd, 100_000n),
    flashLoanFee: createAssetAmount(usdc, 900n),
    slippageBuffer: createAssetAmount(usdc, 750n),
    safetyBuffer: createAssetAmount(usdc, 250n),
    capitalAtRisk: createAssetAmount(usdc, 1_000_000n),
    provider: "aaveV3",
    minimumMarginBps: 50,
  };
}

describe("buildArbitrageExecutionRequest", () => {
  it("builds a flashLoanSimple transaction envelope for safe execution", () => {
    const request = buildArbitrageExecutionRequest(opportunity(), {
      receiverAddress: "0x5555555555555555555555555555555555555555",
      operatorAddress: "0x6666666666666666666666666666666666666666",
    });

    expect(request.chain).toBe("base");
    expect(request.opportunityId).toBe("arb:base:1");
    expect(request.routeInput.minimumMarginBps).toBe(50);

    const tx = request.buildTransaction({ status: "selected", provider: "aaveV3", netProfit: createAssetAmount({ symbol: "USD", decimals: 8 }, 1n), marginBps: 1n });
    const decoded = decodeFunctionData({
      abi: aavePoolAbi,
      data: tx.data,
    });
    expect(decoded.functionName).toBe("flashLoanSimple");
  });
});
