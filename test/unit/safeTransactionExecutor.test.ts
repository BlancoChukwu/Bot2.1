import { describe, expect, it } from "vitest";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { LocalNonceManager } from "../../src/executors/nonceManager";
import {
  SafeTransactionExecutor,
  type ExecutionPreflightClient,
  type SafeExecutionRequest,
} from "../../src/executors/safeTransactionExecutor";

const usd = createAsset({ symbol: "USD", decimals: 8 });
const account = "0x0000000000000000000000000000000000000001";

function request(): SafeExecutionRequest {
  return {
    chain: "optimism",
    account,
    opportunityId: "op-exec",
    gasProfileKey: "aaveV3:flashLiquidation",
    buildTransaction: (route) => ({
      to: "0x0000000000000000000000000000000000000002",
      data: "0x1234",
      provider: route.provider,
    }),
    routeInput: {
      chain: "optimism",
      opportunityId: "op-exec",
      revenue: createAssetAmount(usd, 10_000_000_000n),
      debt: createAssetAmount(usd, 9_800_000_000n),
      gas: createAssetAmount(usd, 25_000_000n),
      swapCost: createAssetAmount(usd, 5_000_000n),
      slippageBuffer: createAssetAmount(usd, 10_000_000n),
      safetyBuffer: createAssetAmount(usd, 5_000_000n),
      capitalAtRisk: createAssetAmount(usd, 9_800_000_000n),
      minimumMarginBps: 50,
    },
  };
}

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

function routeSelected() {
  return {
    status: "selected" as const,
    provider: "aaveV3" as const,
    netProfit: createAssetAmount(usd, 150_000_000n),
    marginBps: 153n,
  };
}

describe("SafeTransactionExecutor", () => {
  it("runs route selection, gas price, and nonce preflight in parallel before final dry-run", async () => {
    const calls: string[] = [];
    let allowResolve = false;
    const waitUntilAllowed = async () => {
      while (!allowResolve) {
        await Promise.resolve();
      }
    };
    const client: ExecutionPreflightClient = {
      estimateGas: async () => {
        calls.push("estimateGas:start");
        await waitUntilAllowed();
        calls.push("estimateGas:end");
        return 900_000n;
      },
      getGasPrice: async () => {
        calls.push("gasPrice:start");
        await waitUntilAllowed();
        calls.push("gasPrice:end");
        return 1_000_000_000n;
      },
      getPendingNonce: async () => {
        calls.push("nonce:start");
        await waitUntilAllowed();
        calls.push("nonce:end");
        return 5;
      },
      simulate: async (_transaction, overrides) => {
        calls.push(`simulate:${overrides.nonce}`);
        return { success: true };
      },
      send: async (_transaction, overrides) => {
        calls.push(`send:${overrides.nonce}`);
        return "0xabc";
      },
      waitForReceipt: async () => ({ status: "included" }),
    };
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: {
        selectBestRoute: async () => {
          calls.push("route:start");
          await waitUntilAllowed();
          calls.push("route:end");
          return routeSelected();
        },
      },
      nonceManager: new LocalNonceManager(),
      client,
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    const executing = executor.execute(request());
    await Promise.resolve();
    expect(calls).toEqual(["route:start", "gasPrice:start", "nonce:start"]);
    allowResolve = true;
    const result = await executing;

    expect(result.status).toBe("sent");
    expect(calls).toContain("estimateGas:start");
    expect(calls).toContain("simulate:5");
    expect(calls).toContain("send:5");
  });

  it("does not submit when mandatory final dry-run simulation fails", async () => {
    let sends = 0;
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 3,
        simulate: async () => ({ success: false, reason: "dry-run-revert" }),
        send: async () => {
          sends += 1;
          return "0xabc";
        },
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    const result = await executor.execute(request());

    expect(result).toEqual({ status: "rejected", reason: "final_simulation_failed" });
    expect(sends).toBe(0);
  });

  it("returns simulated without submitting when dry-run mode is enabled", async () => {
    let sends = 0;
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 3,
        simulate: async () => ({ success: true }),
        send: async () => {
          sends += 1;
          return "0xabc";
        },
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      dryRunMode: true,
    });

    const result = await executor.execute(request());

    expect(result).toEqual({ status: "simulated" });
    expect(sends).toBe(0);
  });

  it("rejects when the request chain and route chain diverge", async () => {
    const unsafeRequest = {
      ...request(),
      routeInput: { ...request().routeInput, chain: "arbitrum" as const },
    };
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 3,
        simulate: async () => ({ success: true }),
        send: async () => "0xabc",
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    await expect(executor.execute(unsafeRequest)).rejects.toThrow("Execution route chain mismatch");
  });

  it("rejects when selected route provider does not match the transaction envelope", async () => {
    const unsafeRequest = {
      ...request(),
      buildTransaction: () => ({
        to: "0x0000000000000000000000000000000000000002" as const,
        data: "0x1234" as const,
        provider: "balancer" as const,
      }),
    };
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 3,
        simulate: async () => ({ success: true }),
        send: async () => "0xabc",
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    const result = await executor.execute(unsafeRequest);

    expect(result).toEqual({ status: "rejected", reason: "route_transaction_mismatch" });
  });

  it("releases the nonce when preflight fails after reservation succeeds", async () => {
    const nonceManager = new LocalNonceManager();
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: {
        selectBestRoute: async () => {
          throw new Error("router unavailable");
        },
      },
      nonceManager,
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 3,
        simulate: async () => ({ success: true }),
        send: async () => "0xabc",
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    await expect(executor.execute(request())).rejects.toThrow("router unavailable");
    const reused = await nonceManager.reserve("optimism", account, async () => 99);

    expect(reused.nonce).toBe(3);
  });

  it("uses cached gas profiles after the first successful estimate", async () => {
    let estimates = 0;
    const chainRegistry = registry();
    const executor = new SafeTransactionExecutor({
      registry: chainRegistry,
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => {
          estimates += 1;
          return 900_000n;
        },
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 3,
        simulate: async () => ({ success: true }),
        send: async () => "0xabc",
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    await executor.execute(request());
    await executor.execute(request());

    expect(estimates).toBe(1);
    expect(chainRegistry.get("optimism").gasProfileCache.get("aaveV3:flashLiquidation")?.gasLimit).toBe(900_000n);
  });

  it("bumps gas and resubmits with the same nonce after an underpriced send", async () => {
    const gasPrices: bigint[] = [];
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 12,
        simulate: async () => ({ success: true }),
        send: async (_transaction, overrides) => {
          gasPrices.push(overrides.gasPrice);
          return gasPrices.length === 1 ? "0xunderpriced" : "0xbumped";
        },
        waitForReceipt: async (hash) =>
          hash === "0xunderpriced"
            ? { status: "underpriced" }
            : { status: "included" },
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      replacementBumpBps: 1_250,
    });

    const result = await executor.execute(request());

    expect(result).toEqual({ status: "sent", txHash: "0xbumped" });
    expect(gasPrices).toEqual([1_000_000_000n, 1_125_000_000n]);
  });

  it("bumps gas and resubmits with the same nonce when send throws an underpriced error", async () => {
    const gasPrices: bigint[] = [];
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 12,
        simulate: async () => ({ success: true }),
        send: async (_transaction, overrides) => {
          gasPrices.push(overrides.gasPrice);
          if (gasPrices.length === 1) {
            throw new Error("replacement transaction underpriced");
          }
          return "0xbumped";
        },
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      replacementBumpBps: 1_250,
    });

    const result = await executor.execute(request());

    expect(result).toEqual({ status: "sent", txHash: "0xbumped" });
    expect(gasPrices).toEqual([1_000_000_000n, 1_125_000_000n]);
  });

  it("routes high-competition transactions through the private bundle router", async () => {
    let publicSends = 0;
    let bundleSends = 0;
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 12,
        simulate: async () => ({ success: true }),
        send: async () => {
          publicSends += 1;
          return "0xpublic";
        },
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      competitorModel: {
        assess: async () => ({ riskBps: 8_500, observedCompetitors: 3 }),
      },
      bundleRouter: {
        send: async (input) => {
          bundleSends += 1;
          expect(input.route).toBe("private_bundle");
          return "0xbundle";
        },
      },
      privateBundleRiskThresholdBps: 7_000,
    });

    const result = await executor.execute(request());

    expect(result).toEqual({ status: "sent", txHash: "0xbundle" });
    expect(publicSends).toBe(0);
    expect(bundleSends).toBe(1);
  });

  it("falls back to public routing when competitor assessment fails", async () => {
    let publicSends = 0;
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 12,
        simulate: async () => ({ success: true }),
        send: async () => {
          publicSends += 1;
          return "0xpublic";
        },
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      competitorModel: {
        assess: async () => {
          throw new Error("mempool feed down");
        },
      },
      bundleRouter: {
        send: async () => "0xbundle",
      },
    });

    const result = await executor.execute(request());

    expect(result).toEqual({ status: "sent", txHash: "0xpublic" });
    expect(publicSends).toBe(1);
  });

  it("uses public fallback when private bundle routing fails and fallback is enabled", async () => {
    let publicSends = 0;
    let bundleSends = 0;
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 12,
        simulate: async () => ({ success: true }),
        send: async () => {
          publicSends += 1;
          return "0xpublic";
        },
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      competitorModel: {
        assess: async () => ({ riskBps: 8_500, observedCompetitors: 3 }),
      },
      bundleRouter: {
        send: async () => {
          bundleSends += 1;
          throw new Error("relay timeout");
        },
      },
      allowPublicFallbackAfterBundleFailure: true,
    });

    const result = await executor.execute(request());

    expect(result).toEqual({ status: "sent", txHash: "0xpublic" });
    expect(bundleSends).toBe(1);
    expect(publicSends).toBe(1);
  });

  it("resyncs the nonce manager after an unknown first-send failure", async () => {
    const nonceManager = new LocalNonceManager();
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager,
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 12,
        simulate: async () => ({ success: true }),
        send: async () => {
          throw new Error("rpc disconnected");
        },
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    const result = await executor.execute(request());
    const reservation = await nonceManager.reserve("optimism", account, async () => 99);

    expect(result).toEqual({ status: "failed", reason: "send_failed" });
    expect(reservation.nonce).toBe(12);
  });

  it("returns a structured failure when replacement send throws", async () => {
    let sends = 0;
    const executor = new SafeTransactionExecutor({
      registry: registry(),
      router: { selectBestRoute: async () => routeSelected() },
      nonceManager: new LocalNonceManager(),
      client: {
        estimateGas: async () => 900_000n,
        getGasPrice: async () => 1_000_000_000n,
        getPendingNonce: async () => 12,
        simulate: async () => ({ success: true }),
        send: async () => {
          sends += 1;
          if (sends === 1) {
            return "0xunderpriced";
          }
          throw new Error("rpc disconnected");
        },
        waitForReceipt: async () => ({ status: "underpriced" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
      replacementBumpBps: 1_250,
    });

    const result = await executor.execute(request());

    expect(result).toEqual({ status: "failed", reason: "send_failed" });
    expect(sends).toBe(2);
  });
});
