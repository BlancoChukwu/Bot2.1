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
    expect(registry.get("optimism").detection.wsPrimary).toBe("wss://optimism.example");
    expect(registry.get("optimism").execution.httpPrimary).toBe("https://optimism.example");
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

  it("throws when requesting an unregistered chain entry", () => {
    const registry = createChainRegistry({
      chains: [{
        chain: "optimism",
        rpcUrl: "https://optimism.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://optimism-subgraph.example",
      }],
    });

    expect(() => registry.get("base")).toThrow(/not registered/);
  });

  it("applies resolved aave addresses and detection/sequencer execution overrides", () => {
    const registry = createChainRegistry({
      chains: [{
        chain: "base",
        rpcUrl: "https://base-rpc.example",
        fallbackRpcUrls: ["https://base-rpc-fallback.example"],
        detection: {
          wsPrimary: "wss://base-primary.example",
          wsSecondary: "wss://base-secondary.example",
          wsTertiary: "wss://base-tertiary.example",
          flashblocksEnabled: true,
        },
        execution: {
          httpPrimary: "https://base-exec.example",
          fallbacks: ["https://base-exec-fallback.example"],
        },
        sequencer: {
          uptimeFeed: "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433",
          directRpc: "https://mainnet-sequencer.base.org",
        },
        resolvedAave: {
          pool: "0x1111111111111111111111111111111111111111",
          poolAddressesProvider: "0x2222222222222222222222222222222222222222",
          uiPoolDataProvider: "0x3333333333333333333333333333333333333333",
        },
        aaveSubgraphUrl: "https://base-subgraph.example",
      }],
    });
    const base = registry.get("base");

    expect(base.chainConfig.aave.pool).toBe("0x1111111111111111111111111111111111111111");
    expect(base.chainConfig.aave.poolAddressesProvider).toBe("0x2222222222222222222222222222222222222222");
    expect(base.chainConfig.aave.uiPoolDataProvider).toBe("0x3333333333333333333333333333333333333333");
    expect(base.detection.wsPrimary).toBe("wss://base-primary.example");
    expect(base.detection.wsSecondary).toBe("wss://base-secondary.example");
    expect(base.detection.wsTertiary).toBe("wss://base-tertiary.example");
    expect(base.detection.flashblocksEnabled).toBe(true);
    expect(base.execution.httpPrimary).toBe("https://base-exec.example");
    expect(base.execution.fallbacks).toEqual(["https://base-exec-fallback.example"]);
    expect(base.sequencer.uptimeFeed).toBe("0xBCF85224fc0756B9Fa45aA7892530B47e10b6433");
    expect(base.sequencer.directRpc).toBe("https://mainnet-sequencer.base.org");
  });
});
