import type { Address } from "viem";

export const MAX_UINT256 = (1n << 256n) - 1n;
export { MAX_UINT256 as MAX_HF_WAD };

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

// Verified Base mainnet L2 Sequencer Uptime Feed proxy per Chainlink docs:
// https://docs.chain.link/data-feeds/l2-sequencer-feeds
export const BASE_SEQUENCER_UPTIME_FEED = "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433" as const;

export const BASE_PROTOCOL_DATA_PROVIDER = "0x2d8A3C5677189723C4cB8873CfC9C8976dfe292C" as const;

// Keyed by Chainlink aggregator address (lowercase lookup at runtime).
// Heartbeat in seconds. Default 3600s + WARN log for unknown feeds.
export const FEED_HEARTBEATS: Record<string, number> = {
  "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70": 3600,
  "0x7e860098f58bbfc8648a4311b374b1d669a2bc6b": 86400,
  "0x07da0e54543a844a80abe69c8a12f22b3aa59f9d": 3600,
};

export const CRITICAL_FEEDS: readonly Address[] = [
  "0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70",
  "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
] as const;

export const SEQUENCER_GRACE_PERIOD_SECONDS = 3600;
export const BOOTSTRAP_MAX_RETRIES = 5;
export const BOOTSTRAP_RETRY_DELAY_MS = 60_000;

export const protocolDataProviderAbi = [
  {
    name: "getReserveConfigurationData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
] as const;
