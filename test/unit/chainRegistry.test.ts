import { describe, expect, it } from "vitest";
import {
  createChainRegistry,
  updateCircuitBreakerState,
  type ChainRegistryInput,
} from "../../src/config/chainRegistry";

const registryInput: ChainRegistryInput = {
  chains: [
    {
      chain: "optimism",
      rpcUrl: "https://optimism.example",
      fallbackRpcUrls: ["https://optimism-fallback.example"],
      wsRpcUrl: "wss://optimism.example",
      aaveSubgraphUrl: "https://optimism-subgraph.example",
    },
    {
      chain: "arbitrum",
      rpcUrl: "https://arbitrum.example",
      fallbackRpcUrls: [],
      aaveSubgraphUrl: "https://arbitrum-subgraph.example",
      flashLoanProviders: ["aaveV3", "balancer"],
    },
  ],
};

describe("createChainRegistry", () => {
  it("builds one production-ready runtime entry per configured chain", () => {
    const registry = createChainRegistry(registryInput);

    expect(registry.listChains()).toEqual(["optimism", "arbitrum"]);
    expect(registry.get("optimism").chainConfig.chainId).toBe(10);
    expect(registry.get("optimism").rpc.primaryUrl).toBe("https://optimism.example");
    expect(registry.get("optimism").flashLoanProviders).toEqual(["aaveV3"]);
    expect(registry.get("arbitrum").flashLoanProviders).toEqual(["aaveV3", "balancer"]);
  });

  it("rejects duplicate chain entries before runtime startup", () => {
    expect(() =>
      createChainRegistry({
        chains: [
          registryInput.chains[0]!,
          { ...registryInput.chains[0]!, rpcUrl: "https://duplicate.example" },
        ],
      }),
    ).toThrow(/duplicate chain/i);
  });

  it("keeps circuit breaker state isolated per chain and subsystem", () => {
    const registry = createChainRegistry(registryInput);
    const updated = updateCircuitBreakerState(registry.get("optimism"), "rpc", {
      status: "open",
      failures: 3,
      openedAtMs: 1_000,
    });

    expect(updated.circuitBreakers.rpc.status).toBe("open");
    expect(updated.circuitBreakers.subgraph.status).toBe("closed");
    expect(registry.get("arbitrum").circuitBreakers.rpc.status).toBe("closed");
  });

  it("updates circuit breaker state through the registry read path", () => {
    const registry = createChainRegistry(registryInput);

    registry.setCircuitBreakerState("optimism", "execution", {
      status: "open",
      failures: 5,
      openedAtMs: 2_000,
    });

    expect(registry.get("optimism").circuitBreakers.execution.status).toBe("open");
    expect(registry.get("optimism").circuitBreakers.execution.failures).toBe(5);
  });

  it("stores gas profile cache stubs without sharing state across chains", () => {
    const registry = createChainRegistry(registryInput);
    registry.get("optimism").gasProfileCache.set("aaveV3:liquidationCall", {
      gasLimit: 900_000n,
      updatedAtMs: 1_000,
    });

    expect(registry.get("optimism").gasProfileCache.get("aaveV3:liquidationCall")?.gasLimit).toBe(900_000n);
    expect(registry.get("arbitrum").gasProfileCache.get("aaveV3:liquidationCall")).toBeUndefined();
  });

  it("registers expansion hooks for future protocol adapters", () => {
    const registry = createChainRegistry({
      chains: [{
        chain: "optimism",
        rpcUrl: "https://optimism.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://optimism-subgraph.example",
        protocolHooks: [{ protocol: "aaveV3", adapterKey: "aave-v3-optimism" }],
      }],
    });

    expect(registry.get("optimism").protocolHooks).toEqual([
      { protocol: "aaveV3", adapterKey: "aave-v3-optimism" },
    ]);
  });
});
