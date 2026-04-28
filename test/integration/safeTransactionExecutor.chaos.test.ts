import { describe, expect, it } from "vitest";
import { createAsset, createAssetAmount } from "../../src/utils/typedAssetMath";
import { createBotMetrics, createLogger } from "../../src/bot";
import { createChainRegistry } from "../../src/config/chainRegistry";
import { LocalNonceManager } from "../../src/executors/nonceManager";
import { SafeTransactionExecutor, type SafeExecutionRequest } from "../../src/executors/safeTransactionExecutor";

const usd = createAsset({ symbol: "USD", decimals: 8 });
const account = "0x0000000000000000000000000000000000000001";

function executionRequest(opportunityId: string): SafeExecutionRequest {
  return {
    chain: "optimism",
    account,
    opportunityId,
    gasProfileKey: "aaveV3:flashLiquidation",
    buildTransaction: (route) => ({
      to: "0x0000000000000000000000000000000000000002",
      data: "0x1234",
      provider: route.provider,
    }),
    routeInput: {
      chain: "optimism",
      opportunityId,
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

describe("SafeTransactionExecutor chaos paths", () => {
  it("preserves unique nonces during concurrent opportunities under gas spikes", async () => {
    const nonces: number[] = [];
    let pendingNonceReads = 0;
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
        getPendingNonce: async () => {
          pendingNonceReads += 1;
          return 40;
        },
        simulate: async () => ({ success: true }),
        send: async (_transaction, overrides) => {
          nonces.push(overrides.nonce);
          return `0x${overrides.nonce.toString(16)}`;
        },
        waitForReceipt: async () => ({ status: "included" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    const [first, second] = await Promise.all([
      executor.execute(executionRequest("op-a")),
      executor.execute(executionRequest("op-b")),
    ]);

    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(nonces).toEqual([40, 41]);
    expect(pendingNonceReads).toBe(1);
  });

  it("reports reorged receipts as failed without retrying blindly", async () => {
    let sends = 0;
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
        getPendingNonce: async () => 44,
        simulate: async () => ({ success: true }),
        send: async () => {
          sends += 1;
          return "0xreorg";
        },
        waitForReceipt: async () => ({ status: "reorged" }),
      },
      logger: createLogger("silent"),
      metrics: createBotMetrics(),
    });

    const result = await executor.execute(executionRequest("op-reorg"));

    expect(result).toEqual({ status: "failed", reason: "receipt_reorged" });
    expect(sends).toBe(1);
  });
});
