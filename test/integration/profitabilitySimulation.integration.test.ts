import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { FlashLoanProviderRouter } from "../../src/profitability/flashLoanProviderRouter";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";

const usd = createAsset({ symbol: "USD", decimals: 8 });

describe("profitability simulation integration", () => {
  it("routes through deterministic precheck and eth_call simulation before selecting a provider", async () => {
    const calls: string[] = [];
    const router = new FlashLoanProviderRouter({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          aaveSubgraphUrl: "https://subgraph.example",
          flashLoanProviders: ["aaveV3", "balancer"],
        }],
      }),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      providerFees: {
        aaveV3: createAssetAmount(usd, 9_000_000n),
        balancer: createAssetAmount(usd, 0n),
      },
      simulator: {
        simulate: async (input) => {
          calls.push(input.provider);
          return input.provider === "aaveV3"
            ? { success: false, reason: "fork-revert" }
            : {
                success: true,
                gas: input.gas,
                swapCost: input.swapCost,
                revenue: createAssetAmount(usd, 10_050_000_000n),
              };
        },
      },
    });

    const route = await router.selectBestRoute({
      chain: "optimism",
      opportunityId: "op-fork-sim",
      revenue: createAssetAmount(usd, 10_000_000_000n),
      debt: createAssetAmount(usd, 9_800_000_000n),
      gas: createAssetAmount(usd, 25_000_000n),
      swapCost: createAssetAmount(usd, 5_000_000n),
      slippageBuffer: createAssetAmount(usd, 10_000_000n),
      safetyBuffer: createAssetAmount(usd, 5_000_000n),
      capitalAtRisk: createAssetAmount(usd, 9_800_000_000n),
      minimumMarginBps: 50,
    });

    expect(calls).toEqual(["aaveV3", "balancer"]);
    expect(route.status).toBe("selected");
    if (route.status !== "selected") {
      throw new Error("Expected selected flash-loan route");
    }
    expect(route.provider).toBe("balancer");
  });
});
