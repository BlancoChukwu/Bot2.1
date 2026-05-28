import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";

export interface BorrowerIndexSeedResult {
  readonly accounts: readonly Address[];
  readonly source: "subgraph" | "envio" | "ormi";
}

export interface BorrowerIndexProvider {
  seed(chain: SupportedChain): Promise<BorrowerIndexSeedResult>;
}
