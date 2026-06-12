import type { Address, Log } from "viem";
import { getChainConfig, type SupportedChain } from "../config/chains";

/** Aave V3 Base pool (`AaveV3Base.POOL`). */
export const AAVE_V3_BASE_POOL = getChainConfig("base").aave.pool;

/**
 * `Borrow(address,address,address,uint256,uint8,uint256,uint16)` topic0.
 * Matches manual cast query and viem ABI encoding.
 */
export const AAVE_V3_BORROW_TOPIC0 =
  "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0" as const;

export function poolAddressForChain(chain: SupportedChain): Address {
  return getChainConfig(chain).aave.pool;
}

export function extractBorrowerAddressesFromLog(log: Log): readonly Address[] {
  const args = (log as Log & {
    readonly args?: {
      readonly user?: Address;
      readonly onBehalfOf?: Address;
    };
  }).args;
  if (args === undefined) {
    return [];
  }
  const out: Address[] = [];
  if (args.onBehalfOf !== undefined) {
    out.push(args.onBehalfOf);
  }
  if (args.user !== undefined && args.user !== args.onBehalfOf) {
    out.push(args.user);
  }
  return out;
}

export function extractBorrowerFromLog(log: Log): Address | undefined {
  const addresses = extractBorrowerAddressesFromLog(log);
  return addresses[0];
}

/** Extracts user/onBehalfOf/repayer addresses from any Aave pool position event log. */
export function extractUserAddressesFromAavePoolLog(log: Log): readonly Address[] {
  const args = (log as Log & {
    readonly args?: {
      readonly user?: Address;
      readonly onBehalfOf?: Address;
      readonly repayer?: Address;
      readonly to?: Address;
    };
  }).args;
  if (args === undefined) {
    return [];
  }
  const out: Address[] = [];
  const candidates = [args.onBehalfOf, args.user, args.repayer, args.to];
  for (const address of candidates) {
    if (address === undefined) {
      continue;
    }
    const key = address.toLowerCase();
    if (!out.some((existing) => existing.toLowerCase() === key)) {
      out.push(address);
    }
  }
  return out;
}
