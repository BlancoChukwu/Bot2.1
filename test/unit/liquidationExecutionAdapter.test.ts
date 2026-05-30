import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters } from "viem";
import { buildLiquidationExecutionRequest, estimateMinimumCollateralOut } from "../../src/executors/liquidationExecutionAdapter";
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
    const encodedRoute = decoded.args[3] as `0x${string}`;
    const decodedRoute = decodeAbiParameters(
      parseAbiParameters(
        "uint8 routeType,address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minCollateralOut,bool receiveAToken",
      ),
      encodedRoute,
    );
    expect(decodedRoute[0]).toBe(0);
    expect(decodedRoute[1]).toBe(candidate.collateralAsset);
    expect(decodedRoute[2]).toBe(candidate.debtAsset);
    expect(decodedRoute[3]).toBe(candidate.account);
    expect(decodedRoute[4]).toBe(candidate.debtToCover);
    expect(decodedRoute[5]).toBeGreaterThan(0n);
  });

  it("builds Balancer Vault flashLoan transaction when balancer route selected", () => {
    const request = buildLiquidationExecutionRequest("base", candidate, {
      ...baseConfig,
      flashLoanReceiverAddress: "0x00000000000000000000000000000000000000bb",
    });
    const transaction = request.buildTransaction({
      status: "selected",
      provider: "balancer",
      marginBps: 50n,
      netProfit: request.routeInput.revenue,
    });

    expect(transaction.to.toLowerCase()).toBe("0xba12222222228d8ba445958a75a0704d566bf2c8");
    expect(transaction.provider).toBe("balancer");
  });

  it("builds flash-loan preview transaction when receiver is configured", () => {
    const request = buildLiquidationExecutionRequest("base", candidate, {
      ...baseConfig,
      flashLoanReceiverAddress: "0x00000000000000000000000000000000000000bb",
      flashLoanReferralCode: 17,
    });
    const selected = {
      status: "selected" as const,
      provider: "aaveV3" as const,
      marginBps: 50n,
      netProfit: request.routeInput.revenue,
    };
    const preview = request.buildFlashLoanPreviewTransaction?.(selected);
    const built = request.buildTransaction(selected);

    expect(preview).toBeDefined();
    expect(preview?.provider).toBe("aaveV3");
    expect(preview?.data).toBe(built.data);
  });

  it("calculates minCollateralOut with non-e-mode close factor defaults", () => {
    const minOut = estimateMinimumCollateralOut({
      ...candidate,
      healthFactor: 960_000_000_000_000_000n,
      liquidationBonusBps: 500,
    }, 500);
    // debtToCover * 50% close factor => 500_000, +5% bonus => 525_000, -5% slippage => 498_750
    expect(minOut).toBe(498_750n);
  });

  it("calculates minCollateralOut with e-mode bonus and 100% close factor", () => {
    const minOut = estimateMinimumCollateralOut({
      ...candidate,
      healthFactor: 940_000_000_000_000_000n,
      closeFactorBps: 10_000,
      effectiveLiquidationBonusBps: 1_000,
    }, 1_000);
    // debtToCover full => 1_000_000, +10% bonus => 1_100_000, -10% slippage => 990_000
    expect(minOut).toBe(990_000n);
  });

  it("rejects request construction when flash wrapper is required but receiver is missing", () => {
    expect(() =>
      buildLiquidationExecutionRequest("optimism", candidate, {
        ...baseConfig,
        requireFlashLoanWrapper: true,
      }),
    ).toThrow(/flashLoanReceiverAddress is required/);
  });
});
