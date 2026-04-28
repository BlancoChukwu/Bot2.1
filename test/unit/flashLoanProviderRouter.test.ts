import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry, updateCircuitBreakerState } from "../../src/config/chainRegistry";
import { FlashLoanProviderRouter } from "../../src/profitability/flashLoanProviderRouter";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";

const usd = createAsset({ symbol: "USD", decimals: 8 });

describe("FlashLoanProviderRouter", () => {
  it("chooses the available provider with highest simulated net profit", async () => {
    const registry = createChainRegistry({
      chains: [{
        chain: "optimism",
        rpcUrl: "https://optimism.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://subgraph.example",
        flashLoanProviders: ["aaveV3", "balancer", "uniswapV3"],
      }],
    });
    const router = new FlashLoanProviderRouter({
      registry,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      providerFees: {
        aaveV3: createAssetAmount(usd, 9_000_000n),
        balancer: createAssetAmount(usd, 0n),
        uniswapV3: createAssetAmount(usd, 4_000_000n),
      },
      simulator: {
        simulate: async (input) => ({
          success: true,
          gas: input.gas,
          swapCost: input.swapCost,
          revenue: input.provider === "balancer"
            ? createAssetAmount(usd, 10_030_000_000n)
            : input.revenue,
        }),
      },
    });

    const route = await router.selectBestRoute({
      chain: "optimism",
      opportunityId: "op-route",
      revenue: createAssetAmount(usd, 10_000_000_000n),
      debt: createAssetAmount(usd, 9_800_000_000n),
      gas: createAssetAmount(usd, 25_000_000n),
      swapCost: createAssetAmount(usd, 5_000_000n),
      slippageBuffer: createAssetAmount(usd, 10_000_000n),
      safetyBuffer: createAssetAmount(usd, 5_000_000n),
      capitalAtRisk: createAssetAmount(usd, 9_800_000_000n),
      minimumMarginBps: 50,
    });

    expect(route.status).toBe("selected");
    if (route.status !== "selected") {
      throw new Error("Expected selected flash-loan route");
    }
    expect(route.provider).toBe("balancer");
    expect(route.netProfit.raw).toBe(185_000_000n);
  });

  it("skips providers when the execution circuit breaker is open", async () => {
    const registry = createChainRegistry({
      chains: [{
        chain: "optimism",
        rpcUrl: "https://optimism.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://subgraph.example",
        flashLoanProviders: ["aaveV3", "balancer"],
      }],
    });
    const closedChain = registry.get("optimism");
    const openChain = updateCircuitBreakerState(closedChain, "execution", {
      status: "open",
      failures: 3,
      openedAtMs: 1_000,
    });
    const router = new FlashLoanProviderRouter({
      registry: {
        listChains: () => ["optimism"],
        get: () => openChain,
        setCircuitBreakerState: () => undefined,
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      providerFees: {
        aaveV3: createAssetAmount(usd, 0n),
        balancer: createAssetAmount(usd, 0n),
      },
      simulator: {
        simulate: async (input) => ({ success: true, gas: input.gas, swapCost: input.swapCost, revenue: input.revenue }),
      },
    });

    const route = await router.selectBestRoute({
      chain: "optimism",
      opportunityId: "op-open",
      revenue: createAssetAmount(usd, 10_000_000_000n),
      debt: createAssetAmount(usd, 9_800_000_000n),
      gas: createAssetAmount(usd, 25_000_000n),
      swapCost: createAssetAmount(usd, 5_000_000n),
      slippageBuffer: createAssetAmount(usd, 10_000_000n),
      safetyBuffer: createAssetAmount(usd, 5_000_000n),
      capitalAtRisk: createAssetAmount(usd, 9_800_000_000n),
      minimumMarginBps: 50,
    });

    expect(route.status).toBe("rejected");
    if (route.status !== "rejected") {
      throw new Error("Expected rejected flash-loan route");
    }
    expect(route.reason).toBe("execution_circuit_open");
  });
});
