import type { Address } from "viem";

/** Moonwell Core on Base. Addresses from https://docs.moonwell.fi/moonwell/protocol-information/contracts */
export const MOONWELL_BASE_COMPTROLLER = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C" as Address;

export interface MoonwellMarket {
  readonly symbol: string;
  readonly underlying: Address;
  readonly mToken: Address;
  readonly underlyingDecimals: number;
  readonly liquidationBonusBps: number;
}

/**
 * Liquidator share of Moonwell's 10% incentive is 7% (700 bps) per protocol docs.
 * Seize math still uses the full incentive internally; we use 700 for EV haircuts.
 */
export const MOONWELL_LIQUIDATOR_BONUS_BPS = 700;

export const MOONWELL_BASE_MARKETS: readonly MoonwellMarket[] = [
  {
    symbol: "USDC",
    underlying: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    mToken: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
    underlyingDecimals: 6,
    liquidationBonusBps: MOONWELL_LIQUIDATOR_BONUS_BPS,
  },
  {
    symbol: "WETH",
    underlying: "0x4200000000000000000000000000000000000006",
    mToken: "0x628ff693426583D9a7FB391E54366292F509D457",
    underlyingDecimals: 18,
    liquidationBonusBps: MOONWELL_LIQUIDATOR_BONUS_BPS,
  },
  {
    symbol: "cbBTC",
    underlying: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    mToken: "0xF877ACaFA28c19b96727966690b2f44d35aD5976",
    underlyingDecimals: 8,
    liquidationBonusBps: MOONWELL_LIQUIDATOR_BONUS_BPS,
  },
  {
    symbol: "cbETH",
    underlying: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    mToken: "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5",
    underlyingDecimals: 18,
    liquidationBonusBps: MOONWELL_LIQUIDATOR_BONUS_BPS,
  },
  {
    symbol: "wstETH",
    underlying: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
    mToken: "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b",
    underlyingDecimals: 18,
    liquidationBonusBps: MOONWELL_LIQUIDATOR_BONUS_BPS,
  },
  {
    symbol: "weETH",
    underlying: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A",
    mToken: "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3",
    underlyingDecimals: 18,
    liquidationBonusBps: MOONWELL_LIQUIDATOR_BONUS_BPS,
  },
  {
    symbol: "EURC",
    underlying: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    mToken: "0xb682c840B5F4FC58B20769E691A6fa1305A501a2",
    underlyingDecimals: 6,
    liquidationBonusBps: MOONWELL_LIQUIDATOR_BONUS_BPS,
  },
] as const;

export function moonwellMTokenForUnderlying(underlying: Address): Address | undefined {
  const needle = underlying.toLowerCase();
  return MOONWELL_BASE_MARKETS.find((market) => market.underlying.toLowerCase() === needle)?.mToken;
}

export function moonwellConstructorLists(): {
  readonly underlyings: readonly Address[];
  readonly mTokens: readonly Address[];
} {
  return {
    underlyings: MOONWELL_BASE_MARKETS.map((market) => market.underlying),
    mTokens: MOONWELL_BASE_MARKETS.map((market) => market.mToken),
  };
}
