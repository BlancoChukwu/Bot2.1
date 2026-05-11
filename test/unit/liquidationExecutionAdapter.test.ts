import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { buildLiquidationExecutionRequest } from "../../src/executors/liquidationExecutionAdapter";
import { aavePoolAbi } from "../../src/protocols/aaveV3";

const candidate = {
  account: "0x0000000000000000000000000000000000000011",
  collateralAsset: "0x0000000000000000000000000000000000000022",
  debtAsset: "0x0000000000000000000000000000000000000033",
  debtToCover: 1_000_000n,
  repayValueUsd: 1000,
  liquidationBonusBps: 500,
  healthFactor: 900_000_000_000_000_000n,
} as const;

const baseConfig = {
  account: "0x00000000000000000000000000000000000000AA",
  minProfitUsd: 10,
  gasCostUsd: 1,
  slippageBps: 50,
  minimumMarginBps: 50,
} as const;

describe("buildLiquidationExecutionRequest", () => {
  it("builds legacy liquidationCall transaction when no receiver is configured", () => {
    const request = buildLiquidationExecutionRequest("optimism", candidate, baseConfig);
    const transaction = request.buildTransaction({ status: "selected", provider: "aaveV3", marginBps: 50n, netProfit: request.routeInput.revenue });
    const decoded = decodeFunctionData({ abi: aavePoolAbi, data: transaction.data });

    expect(decoded.functionName).toBe("liquidationCall");
  });

  it("builds flashLoanSimple liquidation transaction when receiver is configured", () => {
    const request = buildLiquidationExecutionRequest("optimism", candidate, {
      ...baseConfig,
      flashLoanReceiverAddress: "0x00000000000000000000000000000000000000bb",
    });
    const transaction = request.buildTransaction({ status: "selected", provider: "aaveV3", marginBps: 50n, netProfit: request.routeInput.revenue });
    const decoded = decodeFunctionData({ abi: aavePoolAbi, data: transaction.data });

    expect(decoded.functionName).toBe("flashLoanSimple");
  });
});
