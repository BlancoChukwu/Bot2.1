import { encodeFunctionData, parseAbi, type Address } from "viem";

const morphoBlueAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);

const preLiquidationAbi = parseAbi([
  "function preLiquidate(bytes32 marketId, address borrower, uint256 seizedAssets, bytes data)",
]);

export interface MorphoMarketState {
  readonly marketId: `0x${string}`;
  readonly totalSupplyAssets: bigint;
  readonly totalBorrowAssets: bigint;
}

export interface MorphoPosition {
  readonly borrower: Address;
  readonly healthFactorWad: bigint;
  readonly lltvWad: bigint;
  readonly preLltvWad?: bigint;
}

export function isPreLiquidatable(position: MorphoPosition): boolean {
  if (position.preLltvWad === undefined) {
    return false;
  }
  return position.healthFactorWad < position.preLltvWad;
}

export function encodePreLiquidate(input: {
  readonly marketId: `0x${string}`;
  readonly borrower: Address;
  readonly seizedAssets: bigint;
  readonly data?: `0x${string}`;
}): `0x${string}` {
  return encodeFunctionData({
    abi: preLiquidationAbi,
    functionName: "preLiquidate",
    args: [input.marketId, input.borrower, input.seizedAssets, input.data ?? "0x"],
  });
}

export async function readMorphoMarketState(input: {
  readonly client: { readContract(args: Record<string, unknown>): Promise<unknown> };
  readonly morphoBlue: Address;
  readonly marketId: `0x${string}`;
}): Promise<MorphoMarketState> {
  const raw = await input.client.readContract({
    address: input.morphoBlue,
    abi: morphoBlueAbi,
    functionName: "market",
    args: [input.marketId],
  }) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  return {
    marketId: input.marketId,
    totalSupplyAssets: raw[0],
    totalBorrowAssets: raw[2],
  };
}

