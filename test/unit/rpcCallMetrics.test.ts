import { describe, expect, it } from "vitest";
import client from "prom-client";
import {
  attachRpcMetricsToRegistry,
  parseJsonRpcMethod,
  providerHostFromUrl,
  recordRpcRateLimit,
  recordRpcRequest,
  setRpcMetricsRecorder,
} from "../../src/utils/rpcCallMetrics";

describe("rpcCallMetrics", () => {
  it("extracts provider host from RPC URLs", () => {
    expect(providerHostFromUrl("https://base-mainnet.g.alchemy.com/v2/key")).toBe("base-mainnet.g.alchemy.com");
    expect(providerHostFromUrl("not-a-url")).toBe("unknown");
  });

  it("parses single and batch JSON-RPC methods", () => {
    expect(parseJsonRpcMethod(JSON.stringify({ method: "eth_blockNumber" }))).toBe("eth_blockNumber");
    expect(parseJsonRpcMethod(JSON.stringify([
      { method: "eth_call" },
      { method: "eth_call" },
    ]))).toBe("eth_call");
    expect(parseJsonRpcMethod(JSON.stringify([
      { method: "eth_call" },
      { method: "eth_getBalance" },
    ]))).toBe("batch");
    expect(parseJsonRpcMethod(undefined)).toBe("unknown");
    expect(parseJsonRpcMethod("not-json")).toBe("unknown");
  });

  it("records request and rate-limit counters on the prometheus registry", async () => {
    const registry = new client.Registry();
    setRpcMetricsRecorder(attachRpcMetricsToRegistry(registry));

    recordRpcRequest("eth_blockNumber", "rpc.example");
    recordRpcRequest("eth_call", "rpc.example");
    recordRpcRateLimit("rpc.example");

    const metrics = await registry.metrics();
    expect(metrics).toContain('rpc_requests_total{method="eth_blockNumber",provider_host="rpc.example"} 1');
    expect(metrics).toContain('rpc_requests_total{method="eth_call",provider_host="rpc.example"} 1');
    expect(metrics).toContain('rpc_rate_limit_total{provider_host="rpc.example"} 1');
    expect(metrics).toContain("rpc_requests_per_second");
  });

  it("no-ops when no recorder is configured", () => {
    setRpcMetricsRecorder(undefined);
    expect(() => {
      recordRpcRequest("eth_blockNumber", "rpc.example");
      recordRpcRateLimit("rpc.example");
    }).not.toThrow();
  });
});
