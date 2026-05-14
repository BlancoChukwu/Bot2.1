import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { LocalNonceManager } from "../../src/executors/nonceManager";
import { SafeTransactionExecutor, type SafeExecutionRequest } from "../../src/executors/safeTransactionExecutor";
import { PipelineDeadLetterQueue, PipelineOrchestrator } from "../../src/orchestrator/pipelineOrchestrator";
import { ReserveAwareBorrowerCache, type BorrowerSnapshot } from "../../src/monitors/reserveAwareBorrowerCache";
import { BayesianHazardModel, NoRegretOpportunityRanker } from "../../src/optimization/hazardPrediction";

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
    updatedAtMs: Date.now(),
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

describe("Phase 8 optimization chaos paths", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to baseline order when prediction ranking fails", async () => {
    const first = "0x0000000000000000000000000000000000000001";
    const second = "0x0000000000000000000000000000000000000002";
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot(first));
    cache.upsert(snapshot(second));
    const executed: Address[] = [];
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
          executed.push(request.account);
          return { status: "sent", txHash: "0xabc" };
        },
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
      opportunityRanker: {
        rank: async () => {
          throw new Error("learner unavailable");
        },
      },
    });

    await orchestrator.runOnce();

    expect(executed).toEqual([first, second]);
  });

  it("uses learned hazard ranking with private bundle routing under competitor pressure", async () => {
    const risky = "0x0000000000000000000000000000000000000001";
    const safe = "0x0000000000000000000000000000000000000002";
    const model = new BayesianHazardModel();
    model.recordOutcome({ chain: "optimism", opportunityId: `op:${risky}`, features: ["hot-reserve", "providerScore:-2"], expectedProfitBps: 180, outcome: "lost_to_competitor" });
    model.recordOutcome({ chain: "optimism", opportunityId: `op:${risky}`, features: ["hot-reserve", "providerScore:-2"], expectedProfitBps: 180, outcome: "lost_to_competitor" });
    model.recordOutcome({ chain: "optimism", opportunityId: `op:${safe}`, features: ["deep-liquidity", "providerScore:3"], expectedProfitBps: 90, outcome: "won" });
    const ranker = new NoRegretOpportunityRanker({ model });
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot(risky));
    cache.upsert(snapshot(safe));
    const sent: Address[] = [];
    let bundleSends = 0;
    const executor = new SafeTransactionExecutor({
      registry: createChainRegistry({
        chains: [{
          chain: "optimism",
          rpcUrl: "https://optimism.example",
          fallbackRpcUrls: [],
          aaveSubgraphUrl: "https://subgraph.example",
          flashLoanProviders: ["aaveV3"],
        }],
      }),
      router: {
        selectBestRoute: async () => ({
          status: "selected",
          provider: "aaveV3",
          netProfit: createAssetAmount(usd, 150_000_000n),
          marginBps: 153n,
        }),
      },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 30,
        simulateContract: async () => ({ success: true }),
        send: async () => "0xpublic",
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      competitorModel: { assess: async () => ({ riskBps: 8_000, observedCompetitors: 2 }) },
      bundleRouter: {
        send: async () => {
          bundleSends += 1;
          return "0xbundle";
        },
      },
    });
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
          sent.push(request.account);
          return executor.execute(request);
        },
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
      opportunityRanker: {
        rank: async (chain, plans) => {
          const ranked = ranker.rank(plans.map((plan) => ({
            chain,
            opportunityId: plan.request.opportunityId,
            features: plan.request.account === risky
              ? ["hot-reserve", "providerScore:-2"]
              : ["deep-liquidity", "providerScore:3"],
            expectedProfitBps: plan.request.account === risky ? 180 : 90,
            plan,
          })));
          return ranked.map((item) => item.plan);
        },
      },
    });

    await orchestrator.runOnce();

    expect(sent[0]).toBe(safe);
    expect(bundleSends).toBe(2);
  });
});
