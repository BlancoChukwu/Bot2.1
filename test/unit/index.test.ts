import { describe, expect, it } from "vitest";
import { assertArbitrageOracleReadiness, evaluateRuntimeDeploymentSafety, parseRuntimeConfig } from "../../src/index";

describe("parseRuntimeConfig", () => {
  it("parses a valid Optimism runtime config", () => {
    const config = parseRuntimeConfig({
      CHAIN: "optimism",
      RPC_URL: "https://optimism.example",
      AAVE_SUBGRAPH_URL: "https://subgraph.example",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      MIN_PROFIT_USD: "10",
    });

    expect(config.chain).toBe("optimism");
    expect(config.pollIntervalMs).toBe(400);
    expect(config.aaveSubgraphUrl).toBe("https://subgraph.example");
    expect(config.aaveSubgraphByChain.get("optimism")).toBe("https://subgraph.example");
  });

  it("accepts Node.js process.env (Zod 4 z.record rejects the raw env object)", () => {
    const keys = ["CHAIN", "CHAINS", "RPC_URL", "AAVE_SUBGRAPH_URL", "BASE_AAVE_SUBGRAPH_URL", "PRIVATE_KEY"] as const;
    const previous: Partial<Record<(typeof keys)[number], string | undefined>> = {};
    for (const key of keys) {
      previous[key] = process.env[key];
    }
    try {
      delete process.env.CHAINS;
      delete process.env.BASE_AAVE_SUBGRAPH_URL;
      process.env.CHAIN = "optimism";
      process.env.RPC_URL = "https://optimism.example";
      process.env.AAVE_SUBGRAPH_URL = "https://subgraph.example";
      process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
      process.env.SIMULATION_MODE = "true";
      process.env.USE_PIPELINE_ORCHESTRATOR = "false";

      const config = parseRuntimeConfig(process.env);

      expect(config.chain).toBe("optimism");
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("parses multi-chain Aave V3 targets while keeping the first chain as the active legacy target", () => {
    const config = parseRuntimeConfig({
      CHAINS: "optimism, arbitrum",
      RPC_URL: "https://optimism.example",
      AAVE_SUBGRAPH_URL: "https://subgraph.example",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });

    expect(config.chains).toEqual(["optimism", "arbitrum"]);
    expect(config.chain).toBe("optimism");
  });

  it("parses optional arbitrage USD threshold and feed registry JSON", () => {
    const config = parseRuntimeConfig({
      CHAIN: "base",
      RPC_URL: "https://base.example",
      BASE_AAVE_SUBGRAPH_URL:
        "https://gateway.thegraph.com/api/0809d0adbd54399dd534c899c2c7ca91/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      ARBITRAGE_MIN_PROFIT_USD: "0.25",
      PRICE_FEED_REGISTRY_JSON: JSON.stringify({
        base: {
          "0x4200000000000000000000000000000000000006": {
            feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
            priceDecimals: 8,
          },
        },
      }),
    });

    expect(config.arbitrageMinProfitUsd).toBe(0.25);
    expect(config.priceFeedRegistry?.base["0x4200000000000000000000000000000000000006"]?.feed)
      .toBe("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
  });

  it("uses canonical Base Chainlink feeds when no override is provided", () => {
    const config = parseRuntimeConfig({
      CHAIN: "base",
      RPC_URL: "https://base.example",
      BASE_AAVE_SUBGRAPH_URL:
        "https://gateway.thegraph.com/api/0809d0adbd54399dd534c899c2c7ca91/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });

    expect(config.priceFeedRegistry?.base["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]?.feed)
      .toBe("0x7e860098F58bBFC8648a4311b374B1D669a2bc6B");
    expect(config.priceFeedRegistry?.base["0x4200000000000000000000000000000000000006"]?.feed)
      .toBe("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
    expect(config.priceFeedRegistry?.base["0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"]?.feed)
      .toBe("0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D");
  });

  it("rejects live pipeline startup when required Base token feeds are missing", () => {
    expect(() =>
      parseRuntimeConfig({
        CHAIN: "base",
        RPC_URL: "https://base.example",
        BASE_AAVE_SUBGRAPH_URL:
          "https://gateway.thegraph.com/api/0809d0adbd54399dd534c899c2c7ca91/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
        USE_PIPELINE_ORCHESTRATOR: "true",
        SIMULATION_MODE: "false",
        LIQUIDATION_RECEIVER_ADDRESS: "0x00000000000000000000000000000000000000A1",
        PRICE_FEED_REGISTRY_JSON: JSON.stringify({
          base: {
            "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": {
              feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
              priceDecimals: 8,
            },
          },
        }),
      }),
    ).toThrow(/Missing feeds/);
  });

  it("rejects live startup when feed values are stale or non-positive", async () => {
    const config = parseRuntimeConfig({
      CHAIN: "base",
      RPC_URL: "https://base.example",
      BASE_AAVE_SUBGRAPH_URL:
        "https://gateway.thegraph.com/api/0809d0adbd54399dd534c899c2c7ca91/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      USE_PIPELINE_ORCHESTRATOR: "true",
      SIMULATION_MODE: "false",
      LIQUIDATION_RECEIVER_ADDRESS: "0x00000000000000000000000000000000000000A1",
    });

    await expect(assertArbitrageOracleReadiness(config, {
      batchGetUsdPrices: async () => ({
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": 0n, // non-positive (or stale -> guarded to 0)
        "0x4200000000000000000000000000000000000006": 350_000_000_000n,
        "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": 100_000_000_000_000n,
      }),
    })).rejects.toThrow(/startup rejected/i);
  });

  it("defaults to the non-negotiable 0.5 percent minimum net profit margin", () => {
    const config = parseRuntimeConfig({
      RPC_URL: "https://optimism.example",
      AAVE_SUBGRAPH_URL: "https://subgraph.example",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });

    expect(config.minProfitMarginBps).toBe(50);
  });

  it("rejects startup without a private key", () => {
    expect(() =>
      parseRuntimeConfig({
        RPC_URL: "https://optimism.example",
        AAVE_SUBGRAPH_URL: "https://subgraph.example",
      }),
    ).toThrow(/PRIVATE_KEY/);
  });

  it("builds subgraph URL from THE_GRAPH_API_KEY when AAVE_SUBGRAPH_URL is omitted", () => {
    const config = parseRuntimeConfig({
      CHAIN: "optimism",
      RPC_URL: "https://optimism.example",
      THE_GRAPH_API_KEY: "my-key",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });

    expect(config.aaveSubgraphUrl).toBe(
      "https://gateway.thegraph.com/api/my-key/subgraphs/id/3RWFxWNstn4nP3dXiDfKi9GgBoHx7xzc7APkXs1MLEgi",
    );
  });

  it("rejects startup without subgraph URL or The Graph API key", () => {
    expect(() =>
      parseRuntimeConfig({
        RPC_URL: "https://optimism.example",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      }),
    ).toThrow(/Configure subgraph access/);
  });

  it("uses BASE_AAVE_SUBGRAPH_URL for Base when AAVE_SUBGRAPH_URL is omitted", () => {
    const baseUrl =
      "https://gateway.thegraph.com/api/0809d0adbd54399dd534c899c2c7ca91/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF";
    const config = parseRuntimeConfig({
      CHAIN: "base",
      RPC_URL: "https://base.example",
      BASE_AAVE_SUBGRAPH_URL: baseUrl,
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });

    expect(config.aaveSubgraphUrl).toBe(baseUrl);
    expect(config.aaveSubgraphByChain.get("base")).toBe(baseUrl);
  });

  it("defaults flash-loan providers to aaveV3 only when balancer fallback is disabled", () => {
    const config = parseRuntimeConfig({
      CHAIN: "base",
      RPC_URL: "https://base.example",
      BASE_AAVE_SUBGRAPH_URL:
        "https://gateway.thegraph.com/api/0809d0adbd54399dd534c899c2c7ca91/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      FLASH_LOAN_PROVIDERS: "aaveV3,balancer",
      BALANCER_FLASH_FALLBACK: "false",
    });

    expect(config.balancerFlashFallback).toBe(false);
    expect(config.flashLoanProviders).toEqual(["aaveV3"]);
  });

  it("allows balancer only when balancer fallback is explicitly enabled", () => {
    const config = parseRuntimeConfig({
      CHAIN: "base",
      RPC_URL: "https://base.example",
      BASE_AAVE_SUBGRAPH_URL:
        "https://gateway.thegraph.com/api/0809d0adbd54399dd534c899c2c7ca91/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      FLASH_LOAN_PROVIDERS: "aaveV3,balancer",
      BALANCER_FLASH_FALLBACK: "true",
    });

    expect(config.balancerFlashFallback).toBe(true);
    expect(config.flashLoanProviders).toEqual(["aaveV3", "balancer"]);
  });

  it("resolves Base and Optimism subgraph URLs independently for multi-chain", () => {
    const baseUrl =
      "https://gateway.thegraph.com/api/0809d0adbd54399dd534c899c2c7ca91/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF";
    const config = parseRuntimeConfig({
      CHAINS: "base,optimism",
      RPC_URL: "https://example.com",
      BASE_AAVE_SUBGRAPH_URL: baseUrl,
      THE_GRAPH_API_KEY: "graph-key",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });

    expect(config.aaveSubgraphByChain.get("base")).toBe(baseUrl);
    expect(config.aaveSubgraphByChain.get("optimism")).toBe(
      "https://gateway.thegraph.com/api/graph-key/subgraphs/id/3RWFxWNstn4nP3dXiDfKi9GgBoHx7xzc7APkXs1MLEgi",
    );
  });

  it("rejects AaveKit GraphQL URL for AAVE_SUBGRAPH_URL (not a borrower-indexing subgraph)", () => {
    expect(() =>
      parseRuntimeConfig({
        CHAIN: "base",
        RPC_URL: "https://base.example",
        AAVE_SUBGRAPH_URL: "https://api.v3.aave.com/graphql",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      }),
    ).toThrow(/api\.v3\.aave\.com/);
  });

  it("allows polling intervals above the latency floor", () => {
    const config = parseRuntimeConfig({
      RPC_URL: "https://optimism.example",
      AAVE_SUBGRAPH_URL: "https://subgraph.example",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      POLL_INTERVAL_MS: "401",
    });

    expect(config.pollIntervalMs).toBe(401);
  });

  it("rejects polling intervals below the latency floor", () => {
    expect(() =>
      parseRuntimeConfig({
        RPC_URL: "https://optimism.example",
        AAVE_SUBGRAPH_URL: "https://subgraph.example",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
        POLL_INTERVAL_MS: "99",
      }),
    ).toThrow(/POLL_INTERVAL_MS/);
  });

  it("rejects live mode with the placeholder zero private key", () => {
    expect(() =>
      parseRuntimeConfig({
        RPC_URL: "https://optimism.example",
        AAVE_SUBGRAPH_URL: "https://subgraph.example",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000000",
        SIMULATION_MODE: "false",
      }),
    ).toThrow(/placeholder private key/i);
  });

  it("requires LIQUIDATION_RECEIVER_ADDRESS in live pipeline mode", () => {
    expect(() =>
      parseRuntimeConfig({
        CHAIN: "optimism",
        RPC_URL: "https://optimism.example",
        AAVE_SUBGRAPH_URL: "https://subgraph.example",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
        USE_PIPELINE_ORCHESTRATOR: "true",
        SIMULATION_MODE: "false",
      }),
    ).toThrow(/LIQUIDATION_RECEIVER_ADDRESS/);
  });

  it("rejects profit margin below live floor (50 bps)", () => {
    expect(() =>
      parseRuntimeConfig({
        RPC_URL: "https://optimism.example",
        AAVE_SUBGRAPH_URL: "https://subgraph.example",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
        SIMULATION_MODE: "false",
        MIN_PROFIT_MARGIN_BPS: "49",
      }),
    ).toThrow(/MIN_PROFIT_MARGIN_BPS/);
  });

  it("rejects profit margin below simulation floor (40 bps)", () => {
    expect(() =>
      parseRuntimeConfig({
        RPC_URL: "https://optimism.example",
        AAVE_SUBGRAPH_URL: "https://subgraph.example",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
        SIMULATION_MODE: "true",
        MIN_PROFIT_MARGIN_BPS: "39",
      }),
    ).toThrow(/MIN_PROFIT_MARGIN_BPS/);
  });

  it("allows 40 bps margin in simulation", () => {
    const config = parseRuntimeConfig({
      RPC_URL: "https://optimism.example",
      AAVE_SUBGRAPH_URL: "https://subgraph.example",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      SIMULATION_MODE: "true",
      MIN_PROFIT_MARGIN_BPS: "40",
    });
    expect(config.minProfitMarginBps).toBe(40);
  });

  it("blocks live startup through the runtime deployment safety gate", () => {
    const config = parseRuntimeConfig({
      RPC_URL: "https://optimism.example",
      AAVE_SUBGRAPH_URL: "https://subgraph.example",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      SIMULATION_MODE: "false",
    });

    expect(evaluateRuntimeDeploymentSafety(config).status).toBe("blocked");
  });

  it("invalidates dry-run receipts when safety-relevant runtime config changes", () => {
    const config = parseRuntimeConfig({
      CHAINS: "optimism",
      RPC_URL: "https://optimism.example",
      AAVE_SUBGRAPH_URL: "https://subgraph.example",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      SIMULATION_MODE: "false",
      PAGERDUTY_ROUTING_KEY: "pd-key",
      DRY_RUN_SUCCESS: "true",
      DRY_RUN_VALIDATED_AT_MS: String(Date.now()),
      DRY_RUN_CONFIG_HASH: "chains:optimism",
      DRY_RUN_CHAINS: "optimism",
    });

    const result = evaluateRuntimeDeploymentSafety(config);

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reasons).toContain("Dry-run validation config hash does not match current config");
    }
  });

  it("includes capital threshold and executing account in dry-run receipt validation", () => {
    const config = parseRuntimeConfig({
      CHAINS: "optimism",
      RPC_URL: "https://optimism.example",
      AAVE_SUBGRAPH_URL: "https://subgraph.example",
      PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
      MIN_PROFIT_THRESHOLD_ETH: "0.02",
      SIMULATION_MODE: "false",
      PAGERDUTY_ROUTING_KEY: "pd-key",
      DRY_RUN_SUCCESS: "true",
      DRY_RUN_VALIDATED_AT_MS: String(Date.now()),
      DRY_RUN_CONFIG_HASH: JSON.stringify({
        chains: ["optimism"],
        rpcUrl: "https://optimism.example",
        fallbackRpcUrls: [],
        aaveSubgraphUrl: "https://subgraph.example",
        minProfitThresholdEth: "0.01",
        account: "0x0000000000000000000000000000000000000000",
      }),
      DRY_RUN_CHAINS: "optimism",
    });

    const result = evaluateRuntimeDeploymentSafety(config);

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reasons).toContain("Dry-run validation config hash does not match current config");
    }
  });
});
