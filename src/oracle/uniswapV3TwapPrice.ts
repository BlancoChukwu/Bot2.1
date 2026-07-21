import { getAddress, type Address } from "viem";
import {
  computeUniswapV3PoolTvlUsd,
  UNISWAP_V3_FACTORY_BASE,
  type PoolTvlReadClient,
} from "./uniswapV3PoolTvl";
import { mappedAssetDecimals } from "../config/uniswapV3LiquidationRoutes";
import type { UniswapV3FeeTier } from "../protocols/liquidationFlashLoanReceiver";

export const ORACLE_SANITY_TWAP_SECONDS = 1_800;
/** Documented future config option — not wired as a runtime toggle in v1. */
export const ORACLE_SANITY_TWAP_SECONDS_ALT = 900;
export const ORACLE_SANITY_TWAP_MIN_TVL_USD = 50_000;
export const ORACLE_SANITY_DEVIATION_THRESHOLD_PCT = 2;

const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const ZERO = "0x0000000000000000000000000000000000000000";
const USD_SCALE = 10n ** 8n;

const poolMetaAbi = [
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "token1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "observe",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
  },
] as const;

const factoryAbi = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

export type TwapHop = {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee: UniswapV3FeeTier;
};

export type TwapUsdPath =
  | { readonly kind: "stable_peg"; readonly asset: Address }
  | { readonly kind: "hops"; readonly hops: readonly TwapHop[] };

/**
 * Static Uniswap V3 TWAP paths for Base mapped assets.
 * Multi-hop paths must succeed on EVERY hop (fail closed on first thin/unavailable hop).
 */
export function twapUsdPathForAsset(asset: Address): TwapUsdPath | undefined {
  const key = asset.toLowerCase();
  if (key === USDC.toLowerCase()) {
    return { kind: "stable_peg", asset: USDC };
  }
  if (key === WETH.toLowerCase()) {
    return { kind: "hops", hops: [{ tokenIn: WETH, tokenOut: USDC, fee: 3_000 }] };
  }
  if (key === "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf") {
    return { kind: "hops", hops: [{ tokenIn: asset, tokenOut: USDC, fee: 500 }] };
  }
  if (key === "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22") {
    // Prefer deeper WETH pool, then WETH→USDC.
    return {
      kind: "hops",
      hops: [
        { tokenIn: asset, tokenOut: WETH, fee: 500 },
        { tokenIn: WETH, tokenOut: USDC, fee: 3_000 },
      ],
    };
  }
  if (key === "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452") {
    return {
      kind: "hops",
      hops: [
        { tokenIn: asset, tokenOut: WETH, fee: 100 },
        { tokenIn: WETH, tokenOut: USDC, fee: 3_000 },
      ],
    };
  }
  if (key === "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a") {
    return {
      kind: "hops",
      hops: [
        { tokenIn: asset, tokenOut: WETH, fee: 100 },
        { tokenIn: WETH, tokenOut: USDC, fee: 3_000 },
      ],
    };
  }
  if (key === "0x63706e401c06ac8513145b7687a14804d17f814b") {
    return {
      kind: "hops",
      hops: [
        { tokenIn: asset, tokenOut: WETH, fee: 3_000 },
        { tokenIn: WETH, tokenOut: USDC, fee: 3_000 },
      ],
    };
  }
  if (key === "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee") {
    return { kind: "hops", hops: [{ tokenIn: asset, tokenOut: USDC, fee: 3_000 }] };
  }
  if (key === "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42") {
    return { kind: "hops", hops: [{ tokenIn: asset, tokenOut: USDC, fee: 500 }] };
  }
  if (key === "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca") {
    return { kind: "hops", hops: [{ tokenIn: asset, tokenOut: USDC, fee: 100 }] };
  }
  return undefined;
}

export type TwapUsdResult =
  | { readonly ok: true; readonly priceUsd8: bigint; readonly hopsUsed: number }
  | {
    readonly ok: false;
    readonly reason:
      | "unmapped_asset"
      | "pool_missing"
      | "pool_thin"
      | "observe_failed"
      | "decimals_missing"
      | "invalid_price";
    readonly failedHopIndex?: number;
  };

export interface ResolveTwapUsdInput {
  readonly client: PoolTvlReadClient;
  readonly asset: Address;
  readonly secondsAgo?: number;
  readonly minTvlUsd?: number;
  readonly factory?: Address;
}

/**
 * Resolve asset→USD via Uniswap V3 TWAP.
 * Multi-hop: EVERY hop must pass TVL + observe; compounded price is the product of hop ratios.
 */
export async function resolveUniswapV3TwapUsd8(
  input: ResolveTwapUsdInput,
): Promise<TwapUsdResult> {
  const path = twapUsdPathForAsset(input.asset);
  if (path === undefined) {
    return { ok: false, reason: "unmapped_asset" };
  }
  if (path.kind === "stable_peg") {
    return { ok: true, priceUsd8: USD_SCALE, hopsUsed: 0 };
  }

  const secondsAgo = input.secondsAgo ?? ORACLE_SANITY_TWAP_SECONDS;
  const minTvlUsd = input.minTvlUsd ?? ORACLE_SANITY_TWAP_MIN_TVL_USD;
  const factory = input.factory ?? UNISWAP_V3_FACTORY_BASE;

  // Compounded tokenOut-per-tokenIn in 1e18 fixed point across hops.
  let compoundedX18 = 10n ** 18n;
  let hopIndex = 0;
  for (const hop of path.hops) {
    const hopPrice = await readHopPriceX18(input.client, hop, secondsAgo, minTvlUsd, factory);
    if (!hopPrice.ok) {
      return {
        ok: false,
        reason: hopPrice.reason,
        failedHopIndex: hopIndex,
      };
    }
    compoundedX18 = (compoundedX18 * hopPrice.priceX18) / (10n ** 18n);
    hopIndex += 1;
  }

  if (compoundedX18 <= 0n) {
    return { ok: false, reason: "invalid_price" };
  }
  // hops end in USDC (6 decimals treated as $1) → USD 8dp.
  const priceUsd8 = (compoundedX18 * USD_SCALE) / (10n ** 18n);
  if (priceUsd8 <= 0n) {
    return { ok: false, reason: "invalid_price" };
  }
  return { ok: true, priceUsd8, hopsUsed: path.hops.length };
}

async function readHopPriceX18(
  client: PoolTvlReadClient,
  hop: TwapHop,
  secondsAgo: number,
  minTvlUsd: number,
  factory: Address,
): Promise<
  | { readonly ok: true; readonly priceX18: bigint }
  | { readonly ok: false; readonly reason: "pool_missing" | "pool_thin" | "observe_failed" | "decimals_missing" | "invalid_price" }
> {
  const decimalsIn = mappedAssetDecimals(hop.tokenIn);
  const decimalsOut = mappedAssetDecimals(hop.tokenOut);
  if (decimalsIn === undefined || decimalsOut === undefined) {
    return { ok: false, reason: "decimals_missing" };
  }

  const pool = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [hop.tokenIn, hop.tokenOut, hop.fee],
  }) as Address;
  if (pool === ZERO) {
    return { ok: false, reason: "pool_missing" };
  }

  const { tvlUsd } = await computeUniswapV3PoolTvlUsd(client, {
    tokenA: { address: hop.tokenIn, decimals: decimalsIn },
    tokenB: { address: hop.tokenOut, decimals: decimalsOut },
    fee: hop.fee,
    factory,
  });
  if (tvlUsd < minTvlUsd) {
    return { ok: false, reason: "pool_thin" };
  }

  try {
    const [token0, token1, observed] = await Promise.all([
      client.readContract({
        address: pool,
        abi: poolMetaAbi,
        functionName: "token0",
      }) as Promise<Address>,
      client.readContract({
        address: pool,
        abi: poolMetaAbi,
        functionName: "token1",
      }) as Promise<Address>,
      client.readContract({
        address: pool,
        abi: poolMetaAbi,
        functionName: "observe",
        args: [[secondsAgo, 0]],
      }) as Promise<readonly [readonly bigint[], readonly bigint[]]>,
    ]);

    const tickCumulatives = observed[0];
    const older = tickCumulatives[0];
    const newer = tickCumulatives[1];
    if (older === undefined || newer === undefined) {
      return { ok: false, reason: "observe_failed" };
    }
    const tick = Number((newer - older) / BigInt(secondsAgo));
    // Uniswap: 1.0001^tick = amount1/amount0 (raw). Human token1-per-token0:
    // rawRatio * 10^(decimals0 - decimals1).
    const rawRatioX18 = tickToPriceX18(tick);
    if (rawRatioX18 <= 0n) {
      return { ok: false, reason: "invalid_price" };
    }
    const token0Decimals = mappedAssetDecimals(token0);
    const token1Decimals = mappedAssetDecimals(token1);
    if (token0Decimals === undefined || token1Decimals === undefined) {
      return { ok: false, reason: "decimals_missing" };
    }
    const humanToken1PerToken0X18 =
      (rawRatioX18 * 10n ** BigInt(18 + token0Decimals - token1Decimals)) / (10n ** 18n);

    const tokenInIsToken0 = token0.toLowerCase() === hop.tokenIn.toLowerCase();
    const priceX18 = tokenInIsToken0
      ? humanToken1PerToken0X18
      : (10n ** 36n) / humanToken1PerToken0X18;
    if (priceX18 <= 0n) {
      return { ok: false, reason: "invalid_price" };
    }
    return { ok: true, priceX18 };
  } catch {
    return { ok: false, reason: "observe_failed" };
  }
}

export function tickToPriceX18(tick: number): bigint {
  // price = 1.0001^tick approximated for practical Uniswap tick range.
  if (!Number.isFinite(tick) || Math.abs(tick) > 887_272) {
    return 0n;
  }
  const price = Math.pow(1.0001, tick);
  if (!Number.isFinite(price) || price <= 0) {
    return 0n;
  }
  return BigInt(Math.floor(price * 1e18));
}

/** Pure helper for tests: compound hop prices then scale to USD 8dp (USDC terminal). */
export function compoundHopPricesToUsd8(hopPricesX18: readonly bigint[]): bigint {
  let compounded = 10n ** 18n;
  for (const hop of hopPricesX18) {
    compounded = (compounded * hop) / (10n ** 18n);
  }
  return (compounded * USD_SCALE) / (10n ** 18n);
}
