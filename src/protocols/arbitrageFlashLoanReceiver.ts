import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Address } from "viem";

export const arbitrageFlashLoanReceiverAbi = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "executeOperation",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "premium", type: "uint256" },
      { name: "initiator", type: "address" },
      { name: "params", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const routeParams = parseAbiParameters(
  "address buyRouter,address sellRouter,address tokenIn,address tokenOut,uint256 amountIn,uint256 minBuyOut,uint256 minSellOut",
);

export interface EncodedArbitrageRoute {
  readonly buyRouter: Address;
  readonly sellRouter: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly minBuyOut: bigint;
  readonly minSellOut: bigint;
}

export function encodeArbitrageRoute(route: EncodedArbitrageRoute): `0x${string}` {
  return encodeAbiParameters(routeParams, [
    route.buyRouter,
    route.sellRouter,
    route.tokenIn,
    route.tokenOut,
    route.amountIn,
    route.minBuyOut,
    route.minSellOut,
  ]);
}
