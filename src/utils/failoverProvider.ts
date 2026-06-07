import { fallback, http, type FallbackTransport, type HttpTransport } from "viem";
import {
  parseJsonRpcMethod,
  providerHostFromUrl,
  recordRpcRateLimit,
  recordRpcRequest,
} from "./rpcCallMetrics";

export interface FailoverProviderConfig {
  readonly primaryRpcUrl: string;
  readonly fallbackRpcUrls: readonly string[];
  readonly timeoutMs?: number;
  readonly retryCount?: number;
}

export function createFailoverTransportUrls(config: FailoverProviderConfig): string[] {
  const primary = config.primaryRpcUrl.trim();
  if (primary.length === 0) {
    throw new Error("primaryRpcUrl is required");
  }

  const urls = [primary, ...config.fallbackRpcUrls.map((url) => url.trim())];
  return [...new Set(urls.filter((url) => url.length > 0))];
}

export function createFailoverTransport(config: FailoverProviderConfig): FallbackTransport<HttpTransport[]> {
  const timeout = config.timeoutMs ?? 2_000;
  const retryCount = config.retryCount ?? 1;
  const transports = createFailoverTransportUrls(config).map((url) => {
    const providerHost = providerHostFromUrl(url);
    return http(url, {
      retryCount,
      timeout,
      onFetchRequest: (_request, init) => {
        const body = typeof init.body === "string" ? init.body : undefined;
        recordRpcRequest(parseJsonRpcMethod(body), providerHost);
      },
      onFetchResponse: (response) => {
        if (response.status === 429) {
          recordRpcRateLimit(providerHost);
        }
      },
    });
  });

  return fallback(transports);
}
