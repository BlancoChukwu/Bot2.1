import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { arbitrum, base, optimism } from "viem/chains";
import type { SupportedChain } from "../config/chains";

export interface BootstrapRpcEndpoint {
  readonly client: PublicClient;
  readonly host: string;
}

function toViemChain(chain: SupportedChain): Chain {
  if (chain === "optimism") {
    return optimism;
  }
  if (chain === "arbitrum") {
    return arbitrum;
  }
  return base;
}

function hostFromRpcUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

export function dedupeRpcUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function createBootstrapLogClients(
  chain: SupportedChain,
  rpcUrls: readonly string[],
): readonly BootstrapRpcEndpoint[] {
  return dedupeRpcUrls(rpcUrls).map((url) => ({
    client: createPublicClient({
      chain: toViemChain(chain),
      transport: http(url, { retryCount: 0, timeout: 30_000 }),
    }) as unknown as PublicClient,
    host: hostFromRpcUrl(url),
  }));
}

export function isRetryableRpcError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("limit")
    || message.includes("capacity")
    || message.includes("429")
    || message.includes("timeout")
    || message.includes("eai_again")
    || message.includes("fetch failed");
}
