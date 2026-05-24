import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";
import type { BorrowerDiscoveryAdapter } from "./borrowerDiscovery";
import { SUBGRAPH_ID_CURSOR_START, nextSubgraphIdCursor } from "../utils/subgraphIdCursor";

const usersPageQuery = `
  query Borrowers($first: Int!, $lastId: ID!) {
    users(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { borrowedReservesCount_gt: 0, id_gt: $lastId }
    ) {
      id
    }
  }
`;

const accountsPageQuery = `
  query Borrowers($first: Int!, $lastId: ID!) {
    accounts(
      first: $first
      orderBy: id
      orderDirection: asc
      where: { id_gt: $lastId }
    ) {
      id
    }
  }
`;

interface SubgraphPage {
  readonly users?: readonly { readonly id: string }[];
  readonly accounts?: readonly { readonly id: string }[];
}

export interface SubgraphBorrowerDiscoveryConfig {
  readonly protocol: string;
  readonly subgraphUrl: string;
  readonly pageSize?: number;
  readonly queryMode?: "users" | "accounts";
}

export function createSubgraphBorrowerDiscovery(
  config: SubgraphBorrowerDiscoveryConfig,
): BorrowerDiscoveryAdapter {
  const pageSize = config.pageSize ?? 1_000;
  const query = config.queryMode === "accounts" ? accountsPageQuery : usersPageQuery;
  return {
    protocol: config.protocol,
    async listBorrowerAddresses(_chain: SupportedChain): Promise<readonly Address[]> {
      const borrowers = new Set<string>();
      let lastId = SUBGRAPH_ID_CURSOR_START;
      while (true) {
        const page = await requestSubgraphPage<SubgraphPage>(config.subgraphUrl, query, pageSize, lastId);
        const rows = page.users ?? page.accounts ?? [];
        for (const row of rows) {
          const normalized = row.id.toLowerCase();
          if (/^0x[a-f0-9]{40}$/.test(normalized)) {
            borrowers.add(normalized);
          }
        }
        if (rows.length < pageSize) {
          break;
        }
        lastId = nextSubgraphIdCursor(rows, lastId);
      }
      return [...borrowers] as Address[];
    },
  };
}

async function requestSubgraphPage<T>(
  subgraphUrl: string,
  query: string,
  first: number,
  lastId: string,
): Promise<T> {
  const response = await fetch(subgraphUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { first, lastId } }),
  });
  if (!response.ok) {
    throw new Error(`subgraph_borrowers_http_${response.status}`);
  }
  const payload = await response.json() as {
    readonly data?: T;
    readonly errors?: readonly { readonly message?: string }[];
  };
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(payload.errors.map((entry) => entry.message ?? "unknown").join("; "));
  }
  if (payload.data === undefined) {
    throw new Error("subgraph_borrowers_missing_data");
  }
  return payload.data;
}
