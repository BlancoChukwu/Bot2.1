import type { Address } from "viem";
import { canonicalBaseAaveOracleAddress } from "../utils/priceOracleCache";

/** EIP-55 checksummed from bgd-labs/aave-address-book `AaveV3Base` / `GhoBase`. */
export const BASE_AAVE_ORACLE = canonicalBaseAaveOracleAddress;

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
export const BASE_WETH = "0x4200000000000000000000000000000000000006" as Address;
export const BASE_CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;

export const BASE_CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as Address;
export const BASE_USDBC = "0xd9aAEc86B65D6f6A7B5B1b0C42FFA531710b6CA" as Address;
export const BASE_GHO = "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee" as Address;
export const BASE_EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as Address;
export const BASE_WSTETH = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Address;
export const BASE_WEETH = "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A" as Address;

/** Assets priced via Aave `getAssetPrice` on the event-purity cold path. */
export const BASE_AAVE_PRICED_ASSETS: readonly Address[] = [
  BASE_CBETH,
  BASE_GHO,
  BASE_EURC,
  BASE_WSTETH,
  BASE_WEETH,
] as const;

export const BASE_PEG_ASSETS: readonly Address[] = [BASE_USDBC] as const;

export const BASE_GAP_FILL_ASSETS: readonly Address[] = [
  ...BASE_AAVE_PRICED_ASSETS,
  ...BASE_PEG_ASSETS,
] as const;
