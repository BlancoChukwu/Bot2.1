import type { LoggerLike } from "../bot";

const unstableHostPatterns = [/dwellir/i];

export interface WssProviderCheckInput {
  readonly primary?: string;
  readonly secondary?: string;
  readonly tertiary?: string;
  readonly logger: LoggerLike;
}

export function warnIfUnstableWssProvider(input: WssProviderCheckInput): void {
  const tiers: Array<{ readonly tier: string; readonly url?: string }> = [
    ...(input.primary === undefined ? [] : [{ tier: "primary", url: input.primary }]),
    ...(input.secondary === undefined ? [] : [{ tier: "secondary", url: input.secondary }]),
    ...(input.tertiary === undefined ? [] : [{ tier: "tertiary", url: input.tertiary }]),
  ];
  for (const entry of tiers) {
    if (entry.url === undefined) {
      continue;
    }
    const host = tryParseHost(entry.url);
    if (host === undefined) {
      continue;
    }
    for (const pattern of unstableHostPatterns) {
      if (pattern.test(host)) {
        input.logger.warn("wss_provider_unstable_host_detected", {
          tier: entry.tier,
          host,
          recommendation: "Use Alchemy or QuickNode Base WSS with distinct fallback tiers",
        });
      }
    }
  }
  const hosts = tiers
    .map((entry) => (entry.url === undefined ? undefined : tryParseHost(entry.url)))
    .filter((value): value is string => value !== undefined);
  const uniqueHosts = new Set(hosts);
  if (hosts.length >= 2 && uniqueHosts.size < hosts.length) {
    input.logger.warn("wss_provider_duplicate_hosts", {
      hosts,
      recommendation: "Configure PRIMARY/SECONDARY/TERTIARY on distinct providers",
    });
  }
}

function tryParseHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
