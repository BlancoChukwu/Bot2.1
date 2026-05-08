import type { Address } from "viem";
import type { SupportedChain } from "./chains";
import type { DexConfig, TokenPairConfig } from "../monitors/arbitrageScanner";

export interface DexRuntimeConfig {
  readonly dexes: readonly DexConfig[];
  readonly monitoredPairs: readonly TokenPairConfig[];
}

const wethBase = "0x4200000000000000000000000000000000000006";
const usdcBase = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const usdtBase = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const wbtcBase = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";

const wethArbitrum = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const usdcArbitrum = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const usdtArbitrum = "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9";
const wbtcArbitrum = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";

const wethOptimism = "0x4200000000000000000000000000000000000006";
const usdcOptimism = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const usdtOptimism = "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58";
const wbtcOptimism = "0x68f180fcce6836688e9084f035309e29bf0a2095";

function pair(
  tokenIn: Address,
  tokenOut: Address,
  symbolIn: string,
  symbolOut: string,
  decimalsIn: number,
  decimalsOut: number,
): TokenPairConfig {
  return {
    tokenIn,
    tokenOut,
    symbolIn,
    symbolOut,
    decimalsIn,
    decimalsOut,
  };
}

const pairsBase = [
  pair(wethBase, usdcBase, "WETH", "USDC", 18, 6),
  pair(usdcBase, usdtBase, "USDC", "USDT", 6, 6),
  pair(wbtcBase, wethBase, "WBTC", "WETH", 8, 18),
];

const pairsArbitrum = [
  pair(wethArbitrum, usdcArbitrum, "WETH", "USDC", 18, 6),
  pair(usdcArbitrum, usdtArbitrum, "USDC", "USDT", 6, 6),
  pair(wbtcArbitrum, wethArbitrum, "WBTC", "WETH", 8, 18),
];

const pairsOptimism = [
  pair(wethOptimism, usdcOptimism, "WETH", "USDC", 18, 6),
  pair(usdcOptimism, usdtOptimism, "USDC", "USDT", 6, 6),
  pair(wbtcOptimism, wethOptimism, "WBTC", "WETH", 8, 18),
];

export const dexRegistry: Record<SupportedChain, DexRuntimeConfig> = {
  base: {
    dexes: [
      { name: "pancake-v2", router: "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86", feeBps: 25 },
      {
        name: "uniswap-v3-router",
        router: "0x2626664c2603336E57B271c5C0b26F421741e481",
        feeBps: 30,
        quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        quoterPoolFee: 3_000,
      },
    ],
    monitoredPairs: pairsBase,
  },
  arbitrum: {
    dexes: [
      { name: "sushiswap-v2", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", feeBps: 30 },
      {
        name: "uniswap-v3-router",
        router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
        feeBps: 30,
        quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        quoterPoolFee: 3_000,
      },
    ],
    monitoredPairs: pairsArbitrum,
  },
  optimism: {
    dexes: [
      { name: "velodrome-v2", router: "0xa062ae8a9c5e11a02dcfea1f5d9f9d4db65c7b84", feeBps: 20 },
      {
        name: "uniswap-v3-router",
        router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
        feeBps: 30,
        quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        quoterPoolFee: 3_000,
      },
    ],
    monitoredPairs: pairsOptimism,
  },
};

export function createDexesPerChainMap(chains: readonly SupportedChain[]): Map<SupportedChain, DexConfig[]> {
  return new Map(
    chains.map((chain) => [chain, [...dexRegistry[chain].dexes]]),
  );
}

export function createMonitoredPairsPerChainMap(
  chains: readonly SupportedChain[],
): Map<SupportedChain, TokenPairConfig[]> {
  return new Map(
    chains.map((chain) => [chain, [...dexRegistry[chain].monitoredPairs]]),
  );
}
