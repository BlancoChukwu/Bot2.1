import { formatUnits, getAddress, type Address } from "viem";
import { canonicalBaseAaveOracleAddress } from "../utils/priceOracleCache";

/** Uniswap V3 canonical factory on Base (bgd-labs address book). */
export const UNISWAP_V3_FACTORY_BASE = getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const AAVE_ORACLE_PRICE_DECIMALS = 8;

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

const balanceAbi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const oracleAbi = [
  {
    name: "getAssetPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Minimal read surface so this stays trivially mockable in tests. */
export interface PoolTvlReadClient {
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

export interface PoolTvlToken {
  readonly address: Address;
  readonly decimals: number;
}

export interface ComputePoolTvlInput {
  readonly tokenA: PoolTvlToken;
  readonly tokenB: PoolTvlToken;
  readonly fee: number;
  readonly factory?: Address;
  readonly oracle?: Address;
  readonly blockNumber?: bigint;
}

export interface PoolTvlResult {
  readonly tvlUsd: number;
  readonly pool: Address;
}

/**
 * Total-value-locked (USD) of a Uniswap V3 pool, valued with live Aave oracle
 * prices — the same basis the static liquidation route snapshot is defined in.
 * Returns tvlUsd 0 with the zero address when the pool does not exist.
 */
export async function computeUniswapV3PoolTvlUsd(
  client: PoolTvlReadClient,
  input: ComputePoolTvlInput,
): Promise<PoolTvlResult> {
  const factory = input.factory ?? UNISWAP_V3_FACTORY_BASE;
  const oracle = input.oracle ?? canonicalBaseAaveOracleAddress;
  const blockArg = input.blockNumber === undefined ? {} : { blockNumber: input.blockNumber };

  const pool = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [input.tokenA.address, input.tokenB.address, input.fee],
    ...blockArg,
  }) as Address;

  if (pool === ZERO_ADDRESS) {
    return { tvlUsd: 0, pool };
  }

  const [balanceA, balanceB, priceA, priceB] = await Promise.all([
    client.readContract({
      address: input.tokenA.address,
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [pool],
      ...blockArg,
    }) as Promise<bigint>,
    client.readContract({
      address: input.tokenB.address,
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [pool],
      ...blockArg,
    }) as Promise<bigint>,
    client.readContract({
      address: oracle,
      abi: oracleAbi,
      functionName: "getAssetPrice",
      args: [input.tokenA.address],
      ...blockArg,
    }) as Promise<bigint>,
    client.readContract({
      address: oracle,
      abi: oracleAbi,
      functionName: "getAssetPrice",
      args: [input.tokenB.address],
      ...blockArg,
    }) as Promise<bigint>,
  ]);

  const tvlUsd =
    Number(formatUnits(balanceA, input.tokenA.decimals)) * Number(formatUnits(priceA, AAVE_ORACLE_PRICE_DECIMALS))
    + Number(formatUnits(balanceB, input.tokenB.decimals)) * Number(formatUnits(priceB, AAVE_ORACLE_PRICE_DECIMALS));

  return { tvlUsd, pool };
}
