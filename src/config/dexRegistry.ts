import type { Address } from "viem";
import type { SupportedChain } from "./chains";
import type { DexConfig, TokenPairConfig } from "../monitors/arbitrageScanner";

export interface DexEntry {
  readonly name: string;
  readonly router: Address;
  readonly quoter?: Address;
  readonly type: "uniswap-v3" | "pancake-v3";
  readonly feeTiers: readonly number[];
}

export const DEX_REGISTRY: Record<SupportedChain, readonly DexEntry[]> = {
  base: [
    {
      name: "UniswapV3",
      router: "0x2626664c2603336E57B271c5C0b26F421741e481",
      // Base Uniswap V3 QuoterV2
      quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      type: "uniswap-v3",
      feeTiers: [100, 500, 3_000, 10_000],
    },
  ],
  arbitrum: [],
  optimism: [],
};

const BASE_PAIRS: readonly TokenPairConfig[] = [
  {
    tokenIn: "0x4200000000000000000000000000000000000006",
    tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbolIn: "WETH",
    symbolOut: "USDC",
    decimalsIn: 18,
    decimalsOut: 6,
  },
  {
    tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenOut: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    symbolIn: "USDC",
    symbolOut: "USDT",
    decimalsIn: 6,
    decimalsOut: 6,
  },
  {
    tokenIn: "0xcbB7C0000aB88B473b1f5aFe3b2b1C9A6D9a4fA0",
    tokenOut: "0x4200000000000000000000000000000000000006",
    symbolIn: "cbBTC",
    symbolOut: "WETH",
    decimalsIn: 8,
    decimalsOut: 18,
  },
];

export function getDexesForChain(chain: SupportedChain): readonly DexConfig[] {
  return DEX_REGISTRY[chain].map((entry) => ({
    name: entry.name,
    router: entry.router,
    feeBps: 30,
    ...(entry.quoter === undefined ? {} : { quoterV2: entry.quoter, quoterPoolFee: 3_000 }),
  }));
}

export function getMonitoredPairsForChain(chain: SupportedChain): readonly TokenPairConfig[] {
  if (chain !== "base") {
    return [];
  }
  return BASE_PAIRS;
}

export function createMonitoredPairsPerChainMap(): Map<SupportedChain, TokenPairConfig[]> {
  const map = new Map<SupportedChain, TokenPairConfig[]>();
  map.set("base", [...BASE_PAIRS]);
  return map;
}
