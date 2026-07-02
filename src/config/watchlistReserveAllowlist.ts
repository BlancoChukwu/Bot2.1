import type { Address } from "viem";
import { getChainConfig, type SupportedChain } from "./chains";

const baseUsdt = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const baseCbBtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

const symbolToBaseAddress: Record<string, Address> = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDT: baseUsdt,
  USDBC: "0xd9aaEC86B65d86f6A7B5B1b0c42FFA531710B6CA",
  CBBTC: baseCbBtc,
  BTC: baseCbBtc,
  CBETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  WSTETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
  WEETH: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A",
  GHO: "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee",
  EURC: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
  AAVE: "0x63706e401c06ac8513145b7687a14804d17f814b",
  TBTC: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
  SYRUPUSDC: "0x660975730059246a68521a3e2fbd4740173100f5",
  LBTC: "0xecac9c5f704e954931349da37f60e39f515c11c1",
};

export function parseWatchlistReserveAllowlist(
  raw: string | undefined,
  chain: SupportedChain,
): readonly Address[] {
  if (raw === undefined || raw.trim() === "") {
    return defaultAllowlistForChain(chain);
  }
  const symbols = raw.split(",").map((part) => part.trim().toUpperCase()).filter(Boolean);
  const addresses = symbols.map((symbol) => symbolToBaseAddress[symbol]).filter((addr): addr is Address => addr !== undefined);
  return addresses.length > 0 ? addresses : defaultAllowlistForChain(chain);
}

function defaultAllowlistForChain(chain: SupportedChain): readonly Address[] {
  if (chain !== "base") {
    return [];
  }
  const config = getChainConfig(chain);
  const fromPairs = config.aave.reservePairs.flatMap((pair) => [pair.collateralAsset, pair.debtAsset]);
  return [...new Set([...fromPairs, baseUsdt, baseCbBtc])] as readonly Address[];
}
