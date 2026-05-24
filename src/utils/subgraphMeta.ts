const metaQuery = `
  query SubgraphMeta {
    _meta {
      block {
        number
      }
    }
  }
`;

export interface SubgraphMetaResult {
  readonly indexedBlock: bigint;
}

export async function fetchSubgraphIndexedBlock(subgraphUrl: string): Promise<bigint> {
  const response = await fetch(subgraphUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: metaQuery }),
  });
  if (!response.ok) {
    throw new Error(`subgraph_meta_http_${response.status}`);
  }
  const payload = await response.json() as {
    readonly data?: { readonly _meta?: { readonly block?: { readonly number?: number | string } } };
    readonly errors?: readonly { readonly message?: string }[];
  };
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(payload.errors.map((entry) => entry.message ?? "unknown").join("; "));
  }
  const raw = payload.data?._meta?.block?.number;
  if (raw === undefined) {
    throw new Error("subgraph_meta_missing_block_number");
  }
  return BigInt(raw);
}

export function computeSubgraphLag(currentBlock: bigint, indexedBlock: bigint): bigint {
  return currentBlock > indexedBlock ? currentBlock - indexedBlock : 0n;
}
