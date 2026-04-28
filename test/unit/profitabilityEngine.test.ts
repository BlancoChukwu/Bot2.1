import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import {
  ProfitabilityEngine,
  type ProfitSimulationInput,
} from "../../src/profitability/profitabilityEngine";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";

const usd = createAsset({ symbol: "USD", decimals: 8 });

function baseInput(overrides: Partial<ProfitSimulationInput> = {}): ProfitSimulationInput {
  return {
    chain: "optimism",
    opportunityId: "op-1",
    provider: "aaveV3",
    revenue: createAssetAmount(usd, 10_000_000_000n),
    debt: createAssetAmount(usd, 9_800_000_000n),
    gas: createAssetAmount(usd, 25_000_000n),
    flashLoanFee: createAssetAmount(usd, 5_000_000n),
    swapCost: createAssetAmount(usd, 5_000_000n),
    slippageBuffer: createAssetAmount(usd, 10_000_000n),
    safetyBuffer: createAssetAmount(usd, 5_000_000n),
    capitalAtRisk: createAssetAmount(usd, 9_800_000_000n),
    minimumMarginBps: 50,
    ...overrides,
  };
}

describe("ProfitabilityEngine", () => {
  it("accepts only opportunities that pass deterministic margin and eth_call simulation", async () => {
    const engine = new ProfitabilityEngine({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      simulator: {
        simulate: async (input) => ({
          success: true,
          gas: input.gas,
          swapCost: input.swapCost,
          revenue: input.revenue,
        }),
      },
    });

    const result = await engine.evaluate(baseInput());

    expect(result.status).toBe("approved");
    if (result.status !== "approved") {
      throw new Error("Expected approved profitability result");
    }
    expect(result.netProfit.raw).toBe(150_000_000n);
    expect(result.marginBps).toBe(153n);
  });

  it("rejects opportunities below the strict minimum margin before eth_call", async () => {
    let simulations = 0;
    const engine = new ProfitabilityEngine({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      simulator: {
        simulate: async (input) => {
          simulations += 1;
          return { success: true, gas: input.gas, swapCost: input.swapCost, revenue: input.revenue };
        },
      },
    });

    const result = await engine.evaluate(baseInput({
      revenue: createAssetAmount(usd, 9_860_000_000n),
    }));

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("Expected rejected profitability result");
    }
    expect(result.reason).toBe("below_min_profit_margin");
    expect(simulations).toBe(0);
  });

  it("rejects opportunities when eth_call simulation fails after deterministic precheck", async () => {
    const engine = new ProfitabilityEngine({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          aaveSubgraphUrl: "https://subgraph.example",
        }],
      }),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      simulator: {
        simulate: async () => ({ success: false, reason: "AAVE_REVERT" }),
      },
    });

    const result = await engine.evaluate(baseInput());

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("Expected rejected profitability result");
    }
    expect(result.reason).toBe("simulation_failed");
  });
});
