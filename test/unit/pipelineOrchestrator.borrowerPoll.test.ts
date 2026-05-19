import { describe, expect, it, vi } from "vitest";
import { PipelineDeadLetterQueue, PipelineOrchestrator } from "../../src/orchestrator/pipelineOrchestrator";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { ReserveAwareBorrowerCache } from "../../src/monitors/reserveAwareBorrowerCache";

describe("PipelineOrchestrator borrower poll interval", () => {
  it("calls pollFallback on the configured TOP_BORROWER_POLL_INTERVAL_MS cadence", async () => {
    const pollFallback = vi.fn().mockResolvedValue(undefined);
    const registry = createChainRegistry({
      chains: [{
        chain: "base",
        rpcUrl: "https://base.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://subgraph.example",
        flashLoanProviders: ["aaveV3"],
      }],
    });
    const orchestrator = new PipelineOrchestrator({
      registry,
      detection: {
        cache: new ReserveAwareBorrowerCache(),
        start: async () => undefined,
        stop: () => undefined,
        pollFallback,
        getCircuitBreakerState: () => ({ status: "closed", failures: 0 }),
      },
      executor: { execute: async () => ({ status: "simulated" as const }) },
      deadLetters: new PipelineDeadLetterQueue(),
      logger: createLogger("error"),
      metrics: createBotMetrics(),
      borrowerPollIntervalMs: 30_000,
      buildExecutionRequest: () => undefined,
    });

    await orchestrator.runOnce();
    expect(pollFallback).toHaveBeenCalledTimes(1);
    await orchestrator.runOnce();
    expect(pollFallback).toHaveBeenCalledTimes(1);
  });
});
