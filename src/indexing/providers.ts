import type { Address } from "viem";
import type { AaveV3Protocol } from "../protocols/aaveV3";
import type { SupportedChain } from "../config/chains";
import type { BorrowerIndexProvider, BorrowerIndexSeedResult } from "./BorrowerIndexProvider";

export class SubgraphBorrowerIndexProvider implements BorrowerIndexProvider {
  public constructor(private readonly protocol: AaveV3Protocol) {}

  public async seed(_chain: SupportedChain): Promise<BorrowerIndexSeedResult> {
    const accounts = await this.protocol.listBorrowerAddresses?.() ?? [];
    return { source: "subgraph", accounts };
  }
}

export class EnvioBorrowerIndexProvider implements BorrowerIndexProvider {
  public constructor(private readonly protocol: AaveV3Protocol) {}

  public async seed(chain: SupportedChain): Promise<BorrowerIndexSeedResult> {
    // Placeholder implementation until Envio index connector lands.
    const accounts = await this.protocol.listBorrowerAddresses?.() ?? [];
    return { source: "envio", accounts: accounts as Address[] };
  }
}

export class OrmiBorrowerIndexProvider implements BorrowerIndexProvider {
  public constructor(private readonly protocol: AaveV3Protocol) {}

  public async seed(chain: SupportedChain): Promise<BorrowerIndexSeedResult> {
    // Placeholder implementation until Ormi index connector lands.
    const accounts = await this.protocol.listBorrowerAddresses?.() ?? [];
    return { source: "ormi", accounts: accounts as Address[] };
  }
}
