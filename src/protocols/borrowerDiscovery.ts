import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";

export interface BorrowerDiscoveryAdapter {
  readonly protocol: string;
  listBorrowerAddresses(chain: SupportedChain): Promise<readonly Address[]>;
}

export interface BorrowerDiscoveryCounts {
  readonly protocol: string;
  readonly count: number;
}

export async function mergeBorrowerAddresses(
  adapters: readonly BorrowerDiscoveryAdapter[],
  chain: SupportedChain,
): Promise<{ readonly addresses: readonly Address[]; readonly counts: readonly BorrowerDiscoveryCounts[] }> {
  const unique = new Set<string>();
  const counts: BorrowerDiscoveryCounts[] = [];
  for (const adapter of adapters) {
    const listed = await adapter.listBorrowerAddresses(chain);
    let added = 0;
    for (const address of listed) {
      const key = address.toLowerCase();
      if (!unique.has(key)) {
        unique.add(key);
        added += 1;
      }
    }
    counts.push({ protocol: adapter.protocol, count: added });
  }
  return {
    addresses: [...unique].map((value) => value as Address),
    counts,
  };
}
