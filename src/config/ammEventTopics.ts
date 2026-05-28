import { getEventSelector, parseAbiItem } from "viem";

/** Uniswap V3 / Aerodrome Slipstream (concentrated liquidity). */
export const CL_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

/** Aerodrome classic (volatile/stable) pair Swap. */
export const AERODROME_CLASSIC_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)",
);

export const CL_SWAP_TOPIC0 = getEventSelector(CL_SWAP_EVENT);
export const AERODROME_CLASSIC_SWAP_TOPIC0 = getEventSelector(AERODROME_CLASSIC_SWAP_EVENT);

export const AMM_SWAP_TOPIC0_LIST = [CL_SWAP_TOPIC0, AERODROME_CLASSIC_SWAP_TOPIC0] as const;
