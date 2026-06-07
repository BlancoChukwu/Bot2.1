import client from "prom-client";

export interface RpcMetricsRecorder {
  recordRequest(method: string, providerHost: string): void;
  recordRateLimit(providerHost: string): void;
}

let recorder: RpcMetricsRecorder | undefined;

export function setRpcMetricsRecorder(next: RpcMetricsRecorder | undefined): void {
  recorder = next;
}

export function recordRpcRequest(method: string, providerHost: string): void {
  recorder?.recordRequest(method, providerHost);
}

export function recordRpcRateLimit(providerHost: string): void {
  recorder?.recordRateLimit(providerHost);
}

export function providerHostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

export function parseJsonRpcMethod(body: string | undefined): string {
  if (body === undefined || body.length === 0) {
    return "unknown";
  }

  try {
    const parsed = JSON.parse(body) as { method?: string } | Array<{ method?: string }>;
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return "batch";
      }
      const methods = [...new Set(parsed.map((entry) => entry.method ?? "unknown"))];
      return methods.length === 1 ? methods[0]! : "batch";
    }
    return parsed.method ?? "unknown";
  } catch {
    return "unknown";
  }
}

const rollingWindowMs = 1_000;

export function attachRpcMetricsToRegistry(registry: client.Registry): RpcMetricsRecorder {
  const requestsTotal = new client.Counter({
    name: "rpc_requests_total",
    help: "Total JSON-RPC HTTP requests",
    labelNames: ["method", "provider_host"],
    registers: [registry],
  });
  const rateLimitTotal = new client.Counter({
    name: "rpc_rate_limit_total",
    help: "Total RPC HTTP 429 rate-limit responses",
    labelNames: ["provider_host"],
    registers: [registry],
  });
  const requestsPerSecond = new client.Gauge({
    name: "rpc_requests_per_second",
    help: "Rolling 1-second RPC request rate",
    registers: [registry],
  });
  const requestTimestamps: number[] = [];

  function pruneOldTimestamps(now: number): void {
    const cutoff = now - rollingWindowMs;
    while (requestTimestamps.length > 0 && requestTimestamps[0]! < cutoff) {
      requestTimestamps.shift();
    }
  }

  function updateRequestsPerSecond(): void {
    const now = Date.now();
    pruneOldTimestamps(now);
    requestsPerSecond.set(requestTimestamps.length);
  }

  return {
    recordRequest(method, providerHost) {
      requestsTotal.inc({ method, provider_host: providerHost });
      requestTimestamps.push(Date.now());
      updateRequestsPerSecond();
    },
    recordRateLimit(providerHost) {
      rateLimitTotal.inc({ provider_host: providerHost });
    },
  };
}
