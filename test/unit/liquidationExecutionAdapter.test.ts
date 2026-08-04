import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters } from "viem";
import {
  buildLiquidationExecutionRequest,
  computeOracleMinDebtOut,
  estimateMinimumCollateralOut,
  estimateMinimumDebtOut,
  runQuoteFloorGatePhase,
} from "../../src/executors/liquidationExecutionAdapter";
import { aavePoolAbi } from "../../src/protocols/aaveV3";
import { QuoteEngine } from "../../src/mirror/quoteEngine";

const candidate = {
  account: "0x0000000000000000000000000000000000000011",
  collateralAsset: "0x0000000000000000000000000000000000000022",
  debtAsset: "0x0000000000000000000000000000000000000033",
  debtToCover: 1_000_000n,
  repayValueUsd: 1000,
  liquidationBonusBps: 500,
  healthFactor: 900_000_000_000_000_000n,
  collateralReceivedWei: 1_000_000_000_000_000_000n,
} as const;

const baseConfig = {
  account: "0x00000000000000000000000000000000000000AA",
  minProfitUsd: 10,
  gasCostUsd: 1,
  slippageBps: 50,
  minimumMarginBps: 50,
} as const;

const productionRouteSchema =
  "uint8 routeType,address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minDebtOut,bool receiveAToken,uint24 fee";

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
      advisoryMinDebtOut: 42n,
      swapFee: 500,
    });
    const transaction = request.buildTransaction({ status: "selected", provider: "aaveV3", marginBps: 50n, netProfit: request.routeInput.revenue });
    const decoded = decodeFunctionData({ abi: aavePoolAbi, data: transaction.data });

    expect(decoded.functionName).toBe("flashLoanSimple");
    const encodedRoute = decoded.args[3] as `0x${string}`;
    const decodedRoute = decodeAbiParameters(
      parseAbiParameters(productionRouteSchema),
      encodedRoute,
    );
    expect(decodedRoute[0]).toBe(0);
    expect(decodedRoute[1]).toBe(candidate.collateralAsset);
    expect(decodedRoute[2]).toBe(candidate.debtAsset);
    expect(decodedRoute[3]).toBe(candidate.account);
    expect(decodedRoute[4]).toBe(candidate.debtToCover);
    expect(decodedRoute[5]).toBe(42n);
    expect(decodedRoute[6]).toBe(false);
    expect(decodedRoute[7]).toBe(500);
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

  it("calculates legacy minCollateralOut with non-e-mode close factor defaults", () => {
    const minOut = estimateMinimumCollateralOut({
      ...candidate,
      healthFactor: 960_000_000_000_000_000n,
      liquidationBonusBps: 500,
    }, 500);
    // debtToCover * 50% close factor => 500_000, +5% bonus => 525_000, -5% slippage => 498_750
    expect(minOut).toBe(498_750n);
  });

  it("calculates legacy minCollateralOut with e-mode bonus and 100% close factor", () => {
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

describe("estimateMinimumDebtOut (quote-based, debt-asset denominated)", () => {
  it("haircuts QuoterV2 amountOut and never min-caps against repay need", async () => {
    const engine = new QuoteEngine({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      useLocalMirror: false,
    });
    const quotedDebtOut = 10_000_000n; // 10 USDC (6 decimals)
    const client = {
      readContract: vi.fn().mockResolvedValue([quotedDebtOut, 0n, 0, 0n]),
    };
    const minDebtOut = await estimateMinimumDebtOut({
      candidate,
      slippageBps: 200, // 2%
      fee: 500,
      quoteEngine: engine,
      client,
      dex: {
        name: "UniswapV3",
        router: "0x2626664c2603336E57B271c5C0b26F421741e481",
        feeBps: 5,
        quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        quoterPoolFee: 500,
      },
      collateralAmountIn: candidate.collateralReceivedWei,
    });

    // 10_000_000 * (1 - 0.02) = 9_800_000 — pure quote haircut, no min(need).
    expect(minDebtOut).toBe(9_800_000n);
    expect(client.readContract).toHaveBeenCalled();
    // Confirm quoted value exceeds any plausible "need" collapse; floor stays quote-based.
    expect(minDebtOut).toBeGreaterThan(candidate.debtToCover);
  });

  it("returns 0 when collateral amount is missing (cannot invent wei from debt)", async () => {
    const engine = new QuoteEngine({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      useLocalMirror: false,
    });
    const { collateralReceivedWei: _omit, ...withoutCollateral } = candidate;
    void _omit;
    const minDebtOut = await estimateMinimumDebtOut({
      candidate: withoutCollateral,
      slippageBps: 200,
      fee: 3_000,
      quoteEngine: engine,
      client: { readContract: vi.fn() },
      dex: {
        name: "UniswapV3",
        router: "0x2626664c2603336E57B271c5C0b26F421741e481",
        feeBps: 5,
        quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      },
    });
    expect(minDebtOut).toBe(0n);
  });
});

describe("quote floor gate (oracle floor × buffer vs Quoter)", () => {
  // 1 WETH collateral, $2000 / $1, decimals 18→6, swapSlippage 200, buffer 75.
  // fairDebtOut = 2_000_000_000; floor = 1_960_000_000; minAcceptable = 1_945_300_000.
  const collateralBal = 1_000_000_000_000_000_000n;
  const priceCollateralWad18 = 2_000n * 10n ** 18n;
  const priceDebtWad18 = 1n * 10n ** 18n;
  const floorInputs = {
    collateralBal,
    priceCollateral: priceCollateralWad18,
    priceDebt: priceDebtWad18,
    collateralDecimals: 18,
    debtDecimals: 6,
    swapSlippageBps: 200,
    quoteGateBufferBps: 75,
    advisorySlippageBps: 200,
  } as const;

  it("rejects when quotedOut is below minAcceptable", async () => {
    const floor = computeOracleMinDebtOut({
      collateralBal,
      priceCollateral: priceCollateralWad18,
      priceDebt: priceDebtWad18,
      collateralDecimals: 18,
      debtDecimals: 6,
      swapSlippageBps: 200,
    });
    expect(floor).toBe(1_960_000_000n);

    const phase = await runQuoteFloorGatePhase({
      ...floorInputs,
      quote: async () => 1_945_299_999n,
    });
    expect(phase).toEqual({
      outcome: "reject",
      quotedOut: 1_945_299_999n,
      floor: 1_960_000_000n,
      minAcceptable: 1_945_300_000n,
    });
  });

  it("passes when quotedOut meets or exceeds minAcceptable", async () => {
    const phase = await runQuoteFloorGatePhase({
      ...floorInputs,
      quote: async () => 1_945_300_000n,
    });
    expect(phase.outcome).toBe("pass");
    if (phase.outcome !== "pass") {
      return;
    }
    expect(phase.floor).toBe(1_960_000_000n);
    expect(phase.minAcceptable).toBe(1_945_300_000n);
    expect(phase.quotedOut).toBe(1_945_300_000n);
    // advisory = quoted * (1 - 200/10000)
    expect(phase.advisoryMinDebtOut).toBe(1_906_394_000n);
  });

  it("fail-opens (unavailable) when the quote RPC throws — does not reject", async () => {
    const phase = await runQuoteFloorGatePhase({
      ...floorInputs,
      quote: async () => {
        throw new Error("quoter_timeout");
      },
    });
    expect(phase).toEqual({
      outcome: "unavailable",
      reason: "quoter_timeout",
      advisoryMinDebtOut: 0n,
    });
  });

  it("wad18 and base-8 prices yield the same floor (scale-invariant ratio)", () => {
    const wad18 = computeOracleMinDebtOut({
      collateralBal,
      priceCollateral: priceCollateralWad18,
      priceDebt: priceDebtWad18,
      collateralDecimals: 18,
      debtDecimals: 6,
      swapSlippageBps: 200,
    });
    const base8 = computeOracleMinDebtOut({
      collateralBal,
      priceCollateral: 2000n * 10n ** 8n,
      priceDebt: 1n * 10n ** 8n,
      collateralDecimals: 18,
      debtDecimals: 6,
      swapSlippageBps: 200,
    });
    expect(wad18).toBe(base8);
  });
});
