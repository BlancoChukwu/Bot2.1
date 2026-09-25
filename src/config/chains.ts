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
const baseCbBtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const baseCbEth = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const baseWeEth = "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A";
const baseWstEth = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
const baseEurc = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
const baseGho = "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee";

const sharedAavePool = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const sharedProvider = "0xa97684ead0e402dc232d5a977953df7ecbab3cdb";
const optimismUiPoolDataProvider = "0x68100bD5345eA474D93577127C11F39FF8463e93";
const arbitrumUiPoolDataProvider = "0x91E04cf78e53aEBe609e8a7f2003e7EECD743F2B";

/** Base mainnet — Aave V3 addresses from bgd-labs/aave-address-book `AaveV3Base`. */
const baseAavePool = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const basePoolAddressesProvider = "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D";
const baseUiPoolDataProvider = "0x0C6BC4a12039788be08F87e87Cff87FEDbd1D386";

export const chainConfigs: Record<SupportedChain, ChainConfig> = {
  optimism: {
    name: "optimism",
    chainId: 10,
    blockExplorerUrl: "https://optimistic.etherscan.io",
    aave: {
      pool: sharedAavePool,
      poolAddressesProvider: sharedProvider,
      uiPoolDataProvider: optimismUiPoolDataProvider,
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
      uiPoolDataProvider: arbitrumUiPoolDataProvider,
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
      pool: baseAavePool,
      poolAddressesProvider: basePoolAddressesProvider,
      uiPoolDataProvider: baseUiPoolDataProvider,
      reservePairs: [
        {
          collateralAsset: baseWeth,
          debtAsset: baseUsdc,
          defaultDebtToCoverWei: 1_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 500,
        },
        {
          collateralAsset: baseCbBtc,
          debtAsset: baseUsdc,
          defaultDebtToCoverWei: 100_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 750,
        },
        {
          collateralAsset: baseCbEth,
          debtAsset: baseUsdc,
          defaultDebtToCoverWei: 1_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 750,
        },
        {
          collateralAsset: baseWeEth,
          debtAsset: baseUsdc,
          defaultDebtToCoverWei: 1_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 750,
        },
        {
          collateralAsset: baseWstEth,
          debtAsset: baseUsdc,
          defaultDebtToCoverWei: 1_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 600,
        },
        {
          collateralAsset: baseCbBtc,
          debtAsset: baseWeth,
          defaultDebtToCoverWei: 1_000_000_000_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 750,
        },
        {
          collateralAsset: baseWeth,
          debtAsset: baseEurc,
          defaultDebtToCoverWei: 1_000_000n,
          repayValueUsd: 1,
          liquidationBonusBps: 500,
        },
        {
          collateralAsset: baseWeth,
          debtAsset: baseGho,
          defaultDebtToCoverWei: 1_000_000_000_000_000_000n,
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

export function selectReservePairMatchingAssets(
  pairs: readonly AaveReservePair[],
  collateralAsset: Address,
  debtAsset: Address,
): AaveReservePair | undefined {
  const collateral = collateralAsset.toLowerCase();
  const debt = debtAsset.toLowerCase();
  return pairs.find(
    (pair) => pair.collateralAsset.toLowerCase() === collateral && pair.debtAsset.toLowerCase() === debt,
  );
}

export function listConfiguredCollateralAssets(chain: SupportedChain): readonly Address[] {
  return [...new Set(getChainConfig(chain).aave.reservePairs.map((pair) => pair.collateralAsset.toLowerCase()))] as Address[];
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
