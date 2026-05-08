import { createPublicClient, createWalletClient, webSocket, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, optimism } from "viem/chains";
import { createFailoverTransport } from "../utils/failoverProvider";

export type SupportedChain = "optimism" | "arbitrum" | "base";

/** The Graph Network subgraph IDs for Aave V3 borrower discovery (see https://thegraph.com/explorer). */
export const aaveV3TheGraphSubgraphIds: Record<SupportedChain, string> = {
  optimism: "3RWFxWNstn4nP3dXiDfKi9GgBoHx7xzc7APkXs1MLEgi",
  arbitrum: "4xyasjQeREe7PxnF6wVdobZvCw5mhoHZq3T7guRpuNPf",
  base: "BAbf6A2V6fPv8dhH6zJf9X4fQfN9P9S9D2E6n7M8R1yA",
};

export interface AaveReservePair {
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly defaultDebtToCoverWei: bigint;
  readonly repayValueUsd: number;
  readonly liquidationBonusBps: number;
}

export interface ChainConfig {
  readonly name: SupportedChain;
  readonly chainId: number;
  readonly blockExplorerUrl: string;
  readonly aave: {
    readonly pool: Address;
    readonly poolAddressesProvider: Address;
    readonly uiPoolDataProvider: Address;
    readonly reservePairs: readonly AaveReservePair[];
  };
}

export interface ChainClientConfig {
  readonly chain: SupportedChain;
  readonly rpcUrl: string;
  readonly fallbackRpcUrls: readonly string[];
}

export interface ChainWebSocketClientConfig {
  readonly chain: SupportedChain;
  readonly wsRpcUrl: string;
}

export interface ChainWalletClientConfig extends ChainClientConfig {
  readonly privateKey: Hex;
}

const optimismUsdc = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const optimismWeth = "0x4200000000000000000000000000000000000006";
const arbitrumUsdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const arbitrumWeth = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const baseUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const baseWeth = "0x4200000000000000000000000000000000000006";

const sharedAavePool = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const sharedProvider = "0xa97684ead0e402dc232d5a977953df7ecbab3cdb";
const uiPoolDataProvider = "0x86B0521f92a554057e54B93098BA2A6Aaa6514AB";

export const chainConfigs: Record<SupportedChain, ChainConfig> = {
  optimism: {
    name: "optimism",
    chainId: 10,
    blockExplorerUrl: "https://optimistic.etherscan.io",
    aave: {
      pool: sharedAavePool,
      poolAddressesProvider: sharedProvider,
      uiPoolDataProvider,
      reservePairs: [
        {
          collateralAsset: optimismWeth,
          debtAsset: optimismUsdc,
          defaultDebtToCoverWei: 1_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 500,
        },
      ],
    },
  },
  arbitrum: {
    name: "arbitrum",
    chainId: 42161,
    blockExplorerUrl: "https://arbiscan.io",
    aave: {
      pool: sharedAavePool,
      poolAddressesProvider: sharedProvider,
      uiPoolDataProvider,
      reservePairs: [
        {
          collateralAsset: arbitrumWeth,
          debtAsset: arbitrumUsdc,
          defaultDebtToCoverWei: 1_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 500,
        },
      ],
    },
  },
  base: {
    name: "base",
    chainId: 8453,
    blockExplorerUrl: "https://basescan.org",
    aave: {
      pool: sharedAavePool,
      poolAddressesProvider: sharedProvider,
      uiPoolDataProvider,
      reservePairs: [
        {
          collateralAsset: baseWeth,
          debtAsset: baseUsdc,
          defaultDebtToCoverWei: 1_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 500,
        },
      ],
    },
  },
};

export function parseSupportedChain(value: string | undefined): SupportedChain {
  if (value === undefined || value.trim() === "") {
    return "optimism";
  }

  if (value === "optimism" || value === "arbitrum" || value === "base") {
    return value;
  }

  throw new Error(`Unsupported chain: ${value}`);
}

export function getChainConfig(chain: SupportedChain): ChainConfig {
  return chainConfigs[chain];
}

export function createFailoverPublicClient(config: ChainClientConfig) {
  return createPublicClient({
    chain: toViemChain(config.chain),
    transport: createFailoverTransport({
      primaryRpcUrl: config.rpcUrl,
      fallbackRpcUrls: config.fallbackRpcUrls,
    }),
  });
}

export function createFailoverWalletClient(config: ChainWalletClientConfig) {
  const account = privateKeyToAccount(config.privateKey);
  return createWalletClient({
    account,
    chain: toViemChain(config.chain),
    transport: createFailoverTransport({
      primaryRpcUrl: config.rpcUrl,
      fallbackRpcUrls: config.fallbackRpcUrls,
    }),
  });
}

export function createChainWebSocketPublicClient(config: ChainWebSocketClientConfig) {
  return createPublicClient({
    chain: toViemChain(config.chain),
    transport: webSocket(config.wsRpcUrl, { retryCount: 3, timeout: 2_000 }),
  });
}

function toViemChain(chain: SupportedChain) {
  if (chain === "optimism") {
    return optimism;
  }
  if (chain === "arbitrum") {
    return arbitrum;
  }
  return base;
}
