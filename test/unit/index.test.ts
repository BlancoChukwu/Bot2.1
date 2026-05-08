import { describe, expect, it } from "vitest";
import { evaluateRuntimeDeploymentSafety, parseRuntimeConfig } from "../../src/index";

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
  });

  it("accepts Node.js process.env (Zod 4 z.record rejects the raw env object)", () => {
    const keys = ["CHAIN", "RPC_URL", "AAVE_SUBGRAPH_URL", "PRIVATE_KEY"] as const;
    const previous: Partial<Record<(typeof keys)[number], string | undefined>> = {};
    for (const key of keys) {
      previous[key] = process.env[key];
    }
    try {
      process.env.CHAIN = "optimism";
      process.env.RPC_URL = "https://optimism.example";
      process.env.AAVE_SUBGRAPH_URL = "https://subgraph.example";
      process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

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
    ).toThrow(/AAVE_SUBGRAPH_URL/);
  });

  it("rejects polling intervals other than exactly 400ms", () => {
    expect(() =>
      parseRuntimeConfig({
        RPC_URL: "https://optimism.example",
        AAVE_SUBGRAPH_URL: "https://subgraph.example",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
        POLL_INTERVAL_MS: "401",
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

  it("rejects a profit margin below 0.5 percent", () => {
    expect(() =>
      parseRuntimeConfig({
        RPC_URL: "https://optimism.example",
        AAVE_SUBGRAPH_URL: "https://subgraph.example",
        PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
        MIN_PROFIT_MARGIN_BPS: "49",
      }),
    ).toThrow(/MIN_PROFIT_MARGIN_BPS/);
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
