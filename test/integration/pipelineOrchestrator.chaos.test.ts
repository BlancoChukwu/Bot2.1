import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { PipelineDeadLetterQueue, PipelineOrchestrator } from "../../src/orchestrator/pipelineOrchestrator";
import { ReserveAwareBorrowerCache, type BorrowerSnapshot } from "../../src/monitors/reserveAwareBorrowerCache";
import type { SafeExecutionRequest } from "../../src/executors/safeTransactionExecutor";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";

const usd = createAsset({ symbol: "USD", decimals: 8 });
const usdc = createAsset({ symbol: "USDC", decimals: 6 });
const weth = createAsset({ symbol: "WETH", decimals: 18 });
const wethAddress = "0x4200000000000000000000000000000000000006";
const usdcAddress = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";

function snapshot(account: Address): BorrowerSnapshot {
  return {
    chain: "optimism",
    account,
    healthFactor: 900_000_000_000_000_000n,
    updatedAtMs: 1_000,
    reserves: [
      {
        assetAddress: wethAddress,
        asset: weth,
        collateralBalance: createAssetAmount(weth, 1_000_000_000_000_000_000n),
        variableDebt: createAssetAmount(weth, 0n),
        stableDebt: createAssetAmount(weth, 0n),
        priceInQuote: createAssetAmount(usd, 300_000_000_000n),
        usageAsCollateralEnabled: true,
        liquidationBonusBps: 500,
      },
      {
        assetAddress: usdcAddress,
        asset: usdc,
        collateralBalance: createAssetAmount(usdc, 0n),
        variableDebt: createAssetAmount(usdc, 2_000_000_000n),
        stableDebt: createAssetAmount(usdc, 0n),
        priceInQuote: createAssetAmount(usd, 100_000_000n),
        usageAsCollateralEnabled: false,
        liquidationBonusBps: 0,
      },
    ],
  };
}

function requestFor(account: Address): SafeExecutionRequest {
  return {
    chain: "optimism",
    account,
    opportunityId: `op:${account}`,
    gasProfileKey: "aaveV3:flashLiquidation",
    routeInput: {
      chain: "optimism",
      opportunityId: `op:${account}`,
      revenue: createAssetAmount(usd, 10_000_000_000n),
      debt: createAssetAmount(usd, 9_800_000_000n),
      gas: createAssetAmount(usd, 25_000_000n),
      swapCost: createAssetAmount(usd, 5_000_000n),
      slippageBuffer: createAssetAmount(usd, 10_000_000n),
      safetyBuffer: createAssetAmount(usd, 5_000_000n),
      capitalAtRisk: createAssetAmount(usd, 9_800_000_000n),
      minimumMarginBps: 50,
    },
    buildTransaction: (route) => ({
      to: "0x0000000000000000000000000000000000000002",
      data: "0x1234",
      provider: route.provider,
    }),
  };
}

describe("PipelineOrchestrator chaos paths", () => {
  it("isolates executor failures in the dead-letter queue and continues later opportunities", async () => {
    const first = "0x0000000000000000000000000000000000000001";
    const second = "0x0000000000000000000000000000000000000002";
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot(first));
    cache.upsert(snapshot(second));
    const sent: Address[] = [];
    const deadLetters = new PipelineDeadLetterQueue();
    const orchestrator = new PipelineOrchestrator({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          aaveSubgraphUrl: "https://subgraph.example",
          flashLoanProviders: ["aaveV3"],
        }],
      }),
      detection: {
        cache,
        start: async () => undefined,
        stop: () => undefined,
        pollFallback: async () => undefined,
        getCircuitBreakerState: () => ({ status: "closed", failures: 0 }),
      },
      executor: {
        execute: async (request) => {
          if (request.account === first) {
            throw new Error("rpc partition");
          }
          sent.push(request.account);
          return { status: "sent", txHash: "0xabc" };
        },
      },
      deadLetters,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(summary).toMatchObject({ attempted: 2, sent: 1, failed: 1, deadLetters: 1 });
    expect(sent).toEqual([second]);
    expect(deadLetters.list()[0]?.reason).toBe("executor_exception");
  });
});
