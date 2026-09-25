import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, parseAbiParameters } from "viem";
import { getChainConfig } from "../../src/config/chains";
import { moonwellMTokenForUnderlying, MOONWELL_BASE_MARKETS } from "../../src/config/moonwellBase";
import { buildMoonwellLiquidationExecutionRequest } from "../../src/executors/moonwellLiquidationAdapter";
import { encodeMoonwellRoute, encodeLiquidationRoute } from "../../src/protocols/liquidationFlashLoanReceiver";
import { aavePoolAbi } from "../../src/protocols/aaveV3";

const routeAbi = parseAbiParameters(
  "uint8 routeType,address collateralAsset,address debtAsset,address user,uint256 debtToCover,uint256 minCollateralOut,bool receiveAToken",
);

const collateral = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;
const debt = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const user = "0x00000000000000000000000000000000000000aa" as const;

describe("Moonwell production encoding parity", () => {
  it("encodes routeType=1 with the same 7-field ABI the receiver decodes", () => {
    const encoded = encodeMoonwellRoute({
      collateralAsset: collateral,
      debtAsset: debt,
      user,
      debtToCover: 2_954_910_000n,
      minCollateralOut: 3_000_000_000n,
      receiveAToken: false,
    });
    const decoded = decodeAbiParameters(routeAbi, encoded);
    expect(decoded[0]).toBe(1);
    expect(decoded[1].toLowerCase()).toBe(collateral.toLowerCase());
    expect(decoded[2].toLowerCase()).toBe(debt.toLowerCase());
    expect(decoded[3].toLowerCase()).toBe(user.toLowerCase());
    expect(decoded[4]).toBe(2_954_910_000n);
    expect(decoded[5]).toBe(3_000_000_000n);
    expect(decoded[6]).toBe(false);
  });

  it("keeps Aave routeType=0 on the same ABI", () => {
    const encoded = encodeLiquidationRoute({
      collateralAsset: collateral,
      debtAsset: debt,
      user,
      debtToCover: 1n,
      minCollateralOut: 2n,
    });
    const decoded = decodeAbiParameters(routeAbi, encoded);
    expect(decoded[0]).toBe(0);
  });

  it("puts quote-based minCollateralOut into flashLoanSimple params (not 1 wei)", () => {
    const request = buildMoonwellLiquidationExecutionRequest({
      chain: "base",
      account: "0x00000000000000000000000000000000000000bb",
      pool: getChainConfig("base").aave.pool,
      receiver: "0x00000000000000000000000000000000000000cc",
      candidate: {
        account: user,
        collateralAsset: collateral,
        debtAsset: debt,
        debtToCover: 1_000_000_000n,
        repayValueUsd: 1000,
        liquidationBonusBps: 700,
      },
    });
    const tx = request.buildTransaction({
      status: "selected",
      provider: "aaveV3",
      marginBps: 50n,
      netProfit: request.routeInput.revenue,
    });
    const decoded = decodeFunctionData({ abi: aavePoolAbi, data: tx.data });
    expect(decoded.functionName).toBe("flashLoanSimple");
    const route = decodeAbiParameters(routeAbi, decoded.args[3] as `0x${string}`);
    expect(route[0]).toBe(1);
    expect(route[5]).toBeGreaterThan(1n);
  });

  it("maps Base underlyings to published Moonwell mTokens", () => {
    expect(moonwellMTokenForUnderlying(debt)?.toLowerCase()).toBe(
      "0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22",
    );
    expect(MOONWELL_BASE_MARKETS.length).toBeGreaterThanOrEqual(6);
  });
});
