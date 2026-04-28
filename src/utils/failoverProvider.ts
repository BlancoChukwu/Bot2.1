import { fallback, http, type FallbackTransport, type HttpTransport } from "viem";

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
  const transports = createFailoverTransportUrls(config).map((url) =>
    http(url, { retryCount, timeout }),
  );

  return fallback(transports);
}
