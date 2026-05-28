import type { Address } from "viem";
import type { SupportedChain } from "./chains";
import type { DexConfig, TokenPairConfig } from "../monitors/arbitrageScanner";

export interface DexEntry {
  readonly name: string;
  readonly router: Address;
  readonly quoter?: Address;
  readonly type: "uniswap-v3" | "aerodrome-slipstream" | "aerodrome-classic";
  readonly feeTiers: readonly number[];
}

export const DEX_REGISTRY: Record<SupportedChain, readonly DexEntry[]> = {
  base: [
    {
      name: "AerodromeSlipstream",
      router: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
      quoter: "0x254cF9E1E6e233aa1AC962CB9B05b2cFeAAe15b0",
      type: "aerodrome-slipstream",
      feeTiers: [100, 500, 3_000, 10_000],
    },
    {
      name: "AerodromeClassic",
      router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
      type: "aerodrome-classic",
      feeTiers: [1, 5, 30, 100],
    },
    {
      name: "UniswapV3",
      router: "0x2626664c2603336E57B271c5C0b26F421741e481",
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
    tokenIn: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
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
    feeBps: entry.type === "aerodrome-classic" ? 30 : 5,
    ...(entry.quoter === undefined
      ? {}
      : {
        quoterV2: entry.quoter,
        quoterPoolFee: entry.type === "aerodrome-slipstream" ? 500 : 3_000,
      }),
  }));
}

/** Default Slipstream WETH/USDC pool on Base (override via AMM_MIRROR_POOLS). */
export const DEFAULT_BASE_MIRROR_POOLS: readonly Address[] = [
  "0x70da1d52f70e5153b2aca819e0edeaa8e4973fe1",
];

export function resolveMirrorPoolsForChain(chain: SupportedChain): readonly Address[] {
  if (chain !== "base") {
    return [];
  }
  const raw = (process.env.AMM_MIRROR_POOLS ?? "").trim();
  if (raw.length === 0) {
    return DEFAULT_BASE_MIRROR_POOLS;
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^0x[a-fA-F0-9]{40}$/.test(part)) as Address[];
}

export function getEscapeHatchPairs(chain: SupportedChain): readonly TokenPairConfig[] {
  const single = (process.env.ESCAPE_HATCH_SINGLE_PAIR ?? "").trim().toUpperCase();
  if (single === "WETH/USDC" && chain === "base") {
    return [BASE_PAIRS[0]!];
  }
  return getMonitoredPairsForChain(chain);
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
