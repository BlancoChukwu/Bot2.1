import type { BorrowerDiscoveryAdapter } from "./borrowerDiscovery";
import { createSubgraphBorrowerDiscovery } from "./subgraphBorrowerDiscovery";

export interface BorrowerDiscoveryRegistryInput {
  readonly moonwellEnabled?: boolean;
  readonly moonwellSubgraphUrl?: string;
  readonly seamlessEnabled?: boolean;
  readonly seamlessSubgraphUrl?: string;
  readonly moonwellQueryMode?: "users" | "accounts";
  readonly seamlessQueryMode?: "users" | "accounts";
}

export function createBorrowerDiscoveryAdapters(
  input: BorrowerDiscoveryRegistryInput,
): readonly BorrowerDiscoveryAdapter[] {
  const adapters: BorrowerDiscoveryAdapter[] = [];
  if (input.moonwellEnabled && input.moonwellSubgraphUrl !== undefined) {
    adapters.push(createSubgraphBorrowerDiscovery({
      protocol: "moonwell",
      subgraphUrl: input.moonwellSubgraphUrl,
      queryMode: input.moonwellQueryMode ?? "users",
    }));
  }
  if (input.seamlessEnabled && input.seamlessSubgraphUrl !== undefined) {
    adapters.push(createSubgraphBorrowerDiscovery({
      protocol: "seamless",
      subgraphUrl: input.seamlessSubgraphUrl,
      queryMode: input.seamlessQueryMode ?? "users",
    }));
  }
  return adapters;
}

export function parseBorrowerDiscoveryFromEnv(env: NodeJS.ProcessEnv): BorrowerDiscoveryRegistryInput {
  const moonwellSubgraphUrl = trimUrl(env.MOONWELL_SUBGRAPH_URL);
  const seamlessSubgraphUrl = trimUrl(env.SEAMLESS_SUBGRAPH_URL);
  const moonwellQueryMode = parseQueryMode(env.MOONWELL_SUBGRAPH_QUERY_MODE);
  const seamlessQueryMode = parseQueryMode(env.SEAMLESS_SUBGRAPH_QUERY_MODE);
  return {
    moonwellEnabled: parseEnabled(env.MOONWELL_ENABLED),
    ...(moonwellSubgraphUrl === undefined ? {} : { moonwellSubgraphUrl }),
    seamlessEnabled: parseEnabled(env.SEAMLESS_ENABLED),
    ...(seamlessSubgraphUrl === undefined ? {} : { seamlessSubgraphUrl }),
    ...(moonwellQueryMode === undefined ? {} : { moonwellQueryMode }),
    ...(seamlessQueryMode === undefined ? {} : { seamlessQueryMode }),
  };
}

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function trimUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseQueryMode(raw: string | undefined): "users" | "accounts" | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "users" || normalized === "accounts") {
    return normalized;
  }
  return undefined;
}
