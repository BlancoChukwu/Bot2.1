import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry, type CircuitBreakerName, type CircuitBreakerState } from "../../src/config/chainRegistry";
import { PipelineDeadLetterQueue, PipelineOrchestrator, type PipelineDetection } from "../../src/orchestrator/pipelineOrchestrator";
import { ReserveAwareBorrowerCache, type BorrowerSnapshot } from "../../src/monitors/reserveAwareBorrowerCache";
import { StalenessGuard } from "../../src/monitors/stalenessGuard";
import type { SafeExecutionRequest, SafeExecutionResult } from "../../src/executors/safeTransactionExecutor";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";

const usd = createAsset({ symbol: "USD", decimals: 8 });
const usdc = createAsset({ symbol: "USDC", decimals: 6 });
const weth = createAsset({ symbol: "WETH", decimals: 18 });
const account = "0x0000000000000000000000000000000000000001";
const wethAddress = "0x4200000000000000000000000000000000000006";
const usdcAddress = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";

function registry() {
  return createChainRegistry({
    chains: [{
      chain: "optimism",
      rpcUrl: "https://optimism.example",
      fallbackRpcUrls: [],
      aaveSubgraphUrl: "https://subgraph.example",
      flashLoanProviders: ["aaveV3"],
    }],
  });
}

function snapshot(updatedAtMs = 1_000): BorrowerSnapshot {
  return {
    chain: "optimism",
    account,
    healthFactor: 900_000_000_000_000_000n,
    updatedAtMs,
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

function requestFor(accountAddress: Address): SafeExecutionRequest {
  return {
    chain: "optimism",
    account: accountAddress,
    opportunityId: `optimism:${accountAddress}:USDC`,
    gasProfileKey: "aaveV3:flashLiquidation",
    routeInput: {
      chain: "optimism",
      opportunityId: `optimism:${accountAddress}:USDC`,
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

function detection(cache: ReserveAwareBorrowerCache, state?: CircuitBreakerState): PipelineDetection {
  return {
    cache,
    start: async () => undefined,
    stop: () => undefined,
    pollFallback: async () => undefined,
    getCircuitBreakerState: (_chain, name: CircuitBreakerName) =>
      name === "rpc" && state !== undefined ? state : { status: "closed", failures: 0 },
  };
}

describe("PipelineOrchestrator", () => {
  it("executes reserve-aware candidates through the safe executor", async () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot());
    const executed: SafeExecutionRequest[] = [];
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
      executor: {
        execute: async (request) => {
          executed.push(request);
          return { status: "sent", txHash: "0xabc" };
        },
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(summary).toEqual({
      scanned: 1,
      attempted: 1,
      sent: 1,
      simulated: 0,
      rejected: 0,
      failed: 0,
      deadLetters: 0,
      revenue_this_cycle: 0,
      evaluations: 0,
      sims: 0,
      opps_per_block: 0,
    });
    expect(executed[0]?.account).toBe(account);
  });

  it("uses an optional opportunity ranker before execution without changing candidate creation", async () => {
    const firstAccount = "0x0000000000000000000000000000000000000001";
    const secondAccount = "0x0000000000000000000000000000000000000002";
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert({ ...snapshot(), account: firstAccount });
    cache.upsert({ ...snapshot(), account: secondAccount });
    const executed: Address[] = [];
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
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
        rank: async (_chain, plans) => [...plans].reverse(),
      },
    });

    await orchestrator.runOnce();

    expect(executed).toEqual([secondAccount, firstAccount]);
  });

  it("reports execution outcomes back to the online learner", async () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot());
    const outcomes: string[] = [];
    const expectedProfitBps: number[] = [];
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
      executor: {
        execute: async () => ({ status: "sent", txHash: "0xabc" }),
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
      outcomeObserver: {
        recordOutcome: async (outcome) => {
          outcomes.push(`${outcome.opportunityId}:${outcome.outcome}`);
          expectedProfitBps.push(outcome.expectedProfitBps);
        },
      },
    });

    await orchestrator.runOnce();

    expect(outcomes).toEqual([`optimism:${account}:USDC:won`]);
    expect(expectedProfitBps).toEqual([158]);
  });

  it("does not count dry-run simulations as live sent transactions", async () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot());
    const metrics = createBotMetrics();
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
      executor: {
        execute: async () => ({ status: "simulated" }),
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics,
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(summary).toMatchObject({ sent: 0, simulated: 1 });
    expect(metrics.snapshot().liquidationsExecuted).toBe(0);
  });

  it("dead-letters rejected execution results and keeps the loop alive", async () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot());
    const deadLetters = new PipelineDeadLetterQueue();
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
      executor: {
        execute: async (): Promise<SafeExecutionResult> => ({ status: "rejected", reason: "final_simulation_failed" }),
      },
      deadLetters,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(summary.deadLetters).toBe(1);
    expect(deadLetters.list()[0]).toMatchObject({
      chain: "optimism",
      opportunityId: `optimism:${account}:USDC`,
      reason: "final_simulation_failed",
    });
  });

  it("dead-letters request builder exceptions and continues the cycle", async () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot());
    const deadLetters = new PipelineDeadLetterQueue();
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
      executor: {
        execute: async () => ({ status: "sent", txHash: "0xabc" }),
      },
      deadLetters,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: () => {
        throw new Error("missing route economics");
      },
    });

    const summary = await orchestrator.runOnce();

    expect(summary).toMatchObject({ attempted: 0, failed: 1, deadLetters: 1 });
    expect(deadLetters.list()[0]?.reason).toBe("request_builder_exception");
  });

  it("activates degraded fallback polling when the detection RPC circuit is open", async () => {
    const cache = new ReserveAwareBorrowerCache();
    let polls = 0;
    const pipeline = detection(cache, { status: "open", failures: 3, openedAtMs: 1_000 });
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: {
        ...pipeline,
        pollFallback: async () => {
          polls += 1;
          cache.upsert(snapshot(Date.now()));
        },
      },
      executor: {
        execute: async () => ({ status: "sent", txHash: "0xabc" }),
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(polls).toBe(1);
    expect(summary.sent).toBe(1);
  });

  it("does not execute stale cache entries when degraded fallback polling fails", async () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot(1_000));
    let attempts = 0;
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: {
        ...detection(cache, { status: "open", failures: 3, openedAtMs: 1_000 }),
        pollFallback: async () => {
          throw new Error("subgraph outage");
        },
      },
      executor: {
        execute: async () => {
          attempts += 1;
          return { status: "sent", txHash: "0xabc" };
        },
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(attempts).toBe(0);
    expect(summary).toMatchObject({ scanned: 0, attempted: 0, sent: 0 });
  });

  it("executes only fresh snapshots during degraded polling with a mixed cache", async () => {
    const staleAccount = "0x0000000000000000000000000000000000000001";
    const freshAccount = "0x0000000000000000000000000000000000000002";
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert({ ...snapshot(1_000), account: staleAccount });
    cache.upsert({ ...snapshot(Date.now()), account: freshAccount });
    const executed: Address[] = [];
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: {
        ...detection(cache, { status: "open", failures: 3, openedAtMs: 1_000 }),
        pollFallback: async () => undefined,
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
    });

    const summary = await orchestrator.runOnce();

    expect(executed).toEqual([freshAccount]);
    expect(summary).toMatchObject({ scanned: 1, attempted: 1, sent: 1 });
  });


  it("skips execution before preflight when the registry execution circuit is open", async () => {
    const baseRegistry = registry();
    const openChain = {
      ...baseRegistry.get("optimism"),
      circuitBreakers: {
        ...baseRegistry.get("optimism").circuitBreakers,
        execution: { status: "open" as const, failures: 3, openedAtMs: 1_000 },
      },
    };
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot());
    let attempts = 0;
    const orchestrator = new PipelineOrchestrator({
      registry: {
        listChains: () => ["optimism"],
        get: () => openChain,
        getResolvedAave: () => openChain.chainConfig.aave,
        setCircuitBreakerState: () => undefined,
      },
      detection: detection(cache),
      executor: {
        execute: async () => {
          attempts += 1;
          return { status: "sent", txHash: "0xabc" };
        },
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(attempts).toBe(0);
    expect(summary).toMatchObject({ scanned: 0, attempted: 0 });
  });

  it("bounds the dead-letter queue under repeated failures", () => {
    const deadLetters = new PipelineDeadLetterQueue({ maxEntries: 1 });

    deadLetters.enqueue({ chain: "optimism", opportunityId: "op-1", account, reason: "first" });
    deadLetters.enqueue({ chain: "optimism", opportunityId: "op-2", account, reason: "second" });

    expect(deadLetters.list()).toHaveLength(1);
    expect(deadLetters.list()[0]?.opportunityId).toBe("op-2");
    expect(deadLetters.droppedCount()).toBe(1);
  });

  it("pauses execution when sequencer guard reports downtime", async () => {
    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot());
    let attempts = 0;
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
      executor: {
        execute: async () => {
          attempts += 1;
          return { status: "sent", txHash: "0xabc" };
        },
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      sequencerGuard: {
        isUp: async () => false,
      },
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(attempts).toBe(0);
    expect(summary.attempted).toBe(0);
  });

  it("rejects invalid dead-letter queue capacity", () => {
    expect(() => new PipelineDeadLetterQueue({ maxEntries: 0 })).toThrow("maxEntries must be positive");
  });

  it("keeps the resilient main loop alive after a cycle throws", async () => {
    const cache = new ReserveAwareBorrowerCache();
    const controller = new AbortController();
    let cycles = 0;
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: {
        cache,
        start: async () => undefined,
        stop: () => undefined,
        pollFallback: async () => undefined,
        getCircuitBreakerState: () => {
          cycles += 1;
          if (cycles === 1) {
            throw new Error("transient circuit read failure");
          }
          controller.abort();
          return { status: "closed", failures: 0 };
        },
      },
      executor: {
        execute: async () => ({ status: "sent", txHash: "0xabc" }),
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    await orchestrator.runLoop({ pollIntervalMs: 0, signal: controller.signal });

    expect(cycles).toBe(3);
  });

  it("pages after N consecutive watchlist critical cycles", async () => {
    vi.useFakeTimers();
    const guard = new StalenessGuard(1_000);
    guard.record();
    vi.advanceTimersByTime(3_500);

    const cache = new ReserveAwareBorrowerCache();
    const alerts: Array<{ consecutive: number; ageMs: number }> = [];
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
      executor: {
        execute: async () => ({ status: "sent", txHash: "0xabc" }),
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      watchlistStaleness: guard,
      watchlistCriticalAlertCycles: 2,
      onWatchlistStaleCritical: (input) => {
        alerts.push(input);
      },
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    await orchestrator.runOnce();
    await orchestrator.runOnce();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.consecutive).toBe(2);
    vi.useRealTimers();
  });

  it("bypasses critical staleness when event-purity health predicate is true", async () => {
    vi.useFakeTimers();
    const guard = new StalenessGuard(1_000);
    guard.record();
    vi.advanceTimersByTime(3_500);

    const cache = new ReserveAwareBorrowerCache();
    cache.upsert(snapshot());
    const executed: SafeExecutionRequest[] = [];
    const orchestrator = new PipelineOrchestrator({
      registry: registry(),
      detection: detection(cache),
      executor: {
        execute: async (request) => {
          executed.push(request);
          return { status: "sent", txHash: "0xabc" };
        },
      },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      watchlistStaleness: guard,
      eventPurityStalenessBypass: () => true,
      buildExecutionRequest: (candidate) => requestFor(candidate.account),
    });

    const summary = await orchestrator.runOnce();

    expect(summary.sent).toBe(1);
    expect(executed).toHaveLength(1);
    vi.useRealTimers();
  });
});
