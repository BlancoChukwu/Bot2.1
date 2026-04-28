import { describe, expect, it } from "vitest";
import {
  createFlashLoanActions,
  createLiquidationActions,
  LiquidationExecutor,
} from "../../src/executors/liquidationExecutor";
import type { LiquidationCandidate } from "../../src/protocols/aaveV3";

const candidate: LiquidationCandidate = {
  account: "0x0000000000000000000000000000000000000001",
  collateralAsset: "0x0000000000000000000000000000000000000002",
  debtAsset: "0x0000000000000000000000000000000000000003",
  debtToCover: 100n,
  repayValueUsd: 1_000,
  liquidationBonusBps: 500,
  healthFactor: 900_000_000_000_000_000n,
};

describe("LiquidationExecutor", () => {
  it("simulates only and logs when simulation mode is enabled", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const executor = new LiquidationExecutor({
      minProfitWei: 1n,
      simulationMode: true,
      estimateGas: async () => 1_000_000n,
      getGasPrice: async () => 1_000_000_000n,
      getNonce: async () => 7,
      simulate: async () => {
        calls.push("simulate");
      },
      send: async () => {
        calls.push("send");
        return "0xabc";
      },
      logger: {
        info: (message) => logs.push(message),
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const result = await executor.execute({
      ...candidate,
      collateralReceivedWei: 1_000_000_000_000_000_000n,
      bonusPercentage: 500,
    });

    expect(result.status).toBe("simulated");
    expect(calls).toEqual(["simulate"]);
    expect(logs).toContain("SIMULATED liquidation of 0x0000000000000000000000000000000000000001");
  });

  it("adds nonce and a 20 percent gas buffer when executing", async () => {
    const gasLimits: bigint[] = [];
    const executor = new LiquidationExecutor({
      minProfitWei: 1n,
      simulationMode: false,
      estimateGas: async () => 1_000_000n,
      getGasPrice: async () => 1_000_000_000n,
      getNonce: async () => 7,
      simulate: async (_candidate, overrides) => {
        expect(overrides).toBeDefined();
        gasLimits.push(overrides?.gas ?? 0n);
      },
      send: async (_candidate, overrides) => {
        expect(overrides).toBeDefined();
        gasLimits.push(overrides?.gas ?? 0n);
        expect(overrides?.nonce).toBe(7);
        return "0xabc";
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const result = await executor.execute({
      ...candidate,
      collateralReceivedWei: 1_000_000_000_000_000_000n,
      bonusPercentage: 500,
    });

    expect(result.status).toBe("sent");
    expect(gasLimits).toEqual([1_200_000n, 1_200_000n]);
  });

  it("simulates before sending a liquidation transaction", async () => {
    const calls: string[] = [];
    const executor = new LiquidationExecutor({
      minProfitUsd: 10,
      gasCostUsd: 4,
      slippageBps: 50,
      simulate: async () => {
        calls.push("simulate");
      },
      send: async () => {
        calls.push("send");
        return "0xabc";
      },
    });

    const result = await executor.execute(candidate);

    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.txHash).toBe("0xabc");
    }
    expect(calls).toEqual(["simulate", "send"]);
  });

  it("does not send when EV is below minimum profit", async () => {
    const calls: string[] = [];
    const executor = new LiquidationExecutor({
      minProfitUsd: 100,
      gasCostUsd: 4,
      slippageBps: 50,
      simulate: async () => {
        calls.push("simulate");
      },
      send: async () => {
        calls.push("send");
        return "0xabc";
      },
    });

    const result = await executor.execute(candidate);

    expect(result.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("creates viem actions that simulate before write using the Aave pool", async () => {
    const calls: string[] = [];
    const actions = createLiquidationActions({
      pool: "0x0000000000000000000000000000000000000009",
      account: "0x0000000000000000000000000000000000000008",
      publicClient: {
        simulateContract: async (parameters) => {
          calls.push(`simulate:${parameters.functionName}`);
        },
      },
      walletClient: {
        writeContract: async (parameters) => {
          calls.push(`write:${parameters.functionName}`);
          return "0xabc";
        },
      },
    });

    await actions.simulate(candidate);
    const hash = await actions.send(candidate);

    expect(hash).toBe("0xabc");
    expect(calls).toEqual(["simulate:liquidationCall", "write:liquidationCall"]);
  });

  it("creates viem actions for Aave flashLoanSimple", async () => {
    const calls: string[] = [];
    const actions = createFlashLoanActions({
      pool: "0x0000000000000000000000000000000000000009",
      account: "0x0000000000000000000000000000000000000008",
      publicClient: {
        simulateContract: async (parameters) => {
          calls.push(`simulate:${parameters.functionName}`);
        },
      },
      walletClient: {
        writeContract: async (parameters) => {
          calls.push(`write:${parameters.functionName}`);
          return "0xdef";
        },
      },
    });

    await actions.simulate({
      receiverAddress: "0x0000000000000000000000000000000000000007",
      asset: "0x0000000000000000000000000000000000000003",
      amount: 100n,
      encodedParams: "0x1234",
      referralCode: 0,
    });
    const hash = await actions.send({
      receiverAddress: "0x0000000000000000000000000000000000000007",
      asset: "0x0000000000000000000000000000000000000003",
      amount: 100n,
      encodedParams: "0x1234",
      referralCode: 0,
    });

    expect(hash).toBe("0xdef");
    expect(calls).toEqual(["simulate:flashLoanSimple", "write:flashLoanSimple"]);
  });
});
