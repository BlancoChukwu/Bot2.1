import { describe, expect, it } from "vitest";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { PipelineDeadLetterQueue, PipelineOrchestrator } from "../../src/orchestrator/pipelineOrchestrator";
import { ReserveAwareBorrowerCache } from "../../src/monitors/reserveAwareBorrowerCache";
import { buildArbitrageExecutionRequest } from "../../src/executors/arbitrageExecutorAdapter";
import type { Opportunity } from "../../src/types/opportunity";
import { fromArbitrageOpportunity } from "../../src/types/opportunity";
import { createAssetAmount } from "../../src/utils/typedAssetMath";

function arbitrageOpportunity(): Opportunity {
  const usd = { symbol: "USD", decimals: 8 } as const;
  const usdc = { symbol: "USDC", decimals: 6 } as const;
  return fromArbitrageOpportunity({
    chain: "base",
    opportunityId: "arb:base:test",
    buyDex: { name: "buy", router: "0x1111111111111111111111111111111111111111", feeBps: 30 },
    sellDex: { name: "sell", router: "0x2222222222222222222222222222222222222222", feeBps: 30 },
    tokenIn: "0x3333333333333333333333333333333333333333",
    tokenOut: "0x4444444444444444444444444444444444444444",
    amountIn: 1_000_000n,
    expectedAmountOut: 1_050_000n,
    expectedRevenue: createAssetAmount(usdc, 50_000n),
    estimatedGas: createAssetAmount(usd, 100_000n),
    flashLoanFee: createAssetAmount(usdc, 900n),
    slippageBuffer: createAssetAmount(usdc, 500n),
    safetyBuffer: createAssetAmount(usdc, 200n),
    capitalAtRisk: createAssetAmount(usdc, 1_000_000n),
    provider: "aaveV3",
    minimumMarginBps: 50,
  });
}

describe("arbitrage pipeline integration", () => {
  it("consumes arbitrage opportunities through buildExecutionRequestForOpportunity", async () => {
    const registry = createChainRegistry({
      chains: [{
        chain: "base",
        rpcUrl: "https://base.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://subgraph.example",
      }],
    });
    let executed = 0;
    const orchestrator = new PipelineOrchestrator({
      registry,
      detection: {
        cache: new ReserveAwareBorrowerCache(),
        start: async () => undefined,
        stop: () => undefined,
        pollFallback: async () => undefined,
        getCircuitBreakerState: () => ({ status: "closed", failures: 0 }),
        collectExtraOpportunities: async () => [arbitrageOpportunity()],
      },
      executor: {
        execute: async () => {
          executed += 1;
          return { status: "simulated" as const };
        },
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: () => undefined,
      buildExecutionRequestForOpportunity: (opportunity) => {
        if (opportunity.kind !== "arbitrage") {
          return undefined;
        }
        return buildArbitrageExecutionRequest(opportunity.candidate, {
          receiverAddress: "0x5555555555555555555555555555555555555555",
          operatorAddress: "0x6666666666666666666666666666666666666666",
        });
      },
    });

    const summary = await orchestrator.runOnce();

    expect(executed).toBe(1);
    expect(summary.simulated).toBe(1);
  });
});
