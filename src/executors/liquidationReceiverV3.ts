/**
 * LiquidationFlashReceiverV3 encoder/decoder + readiness helpers.
 *
 * NOT wired into the live execution path. The live bot still uses the v1/v2
 * 5-field layout (or the transitional 7-field encoder in
 * `src/protocols/liquidationFlashLoanReceiver.ts`). Switch the adapter over to
 * this module only at a future redeploy when the V3 receiver is live.
 *
 * Layout (abi-encoded, 7 fields):
 *   (uint8 routeType, address collateral, address debt, address user,
 *    uint256 debtToCover, uint256 minCollateralOut, bool receiveAToken)
 *
 * Semantics:
 * - routeType MUST be 0 (Aave V3). The contract reverts on any other value.
 * - minCollateralOut is, despite the historical name, the minimum DEBT-token
 *   amount the collateral->debt swap must return ("minDebtOut"). The contract
 *   enforces amountOutMinimum = max(minCollateralOut, amount + premium).
 * - receiveAToken MUST be false.
 * - Uniswap V3 fee is NOT in params; it is set on-chain via owner.setPoolFee.
 *
 * Initiation (compatible with today's TS path):
 *   the bot EOA calls Pool.flashLoanSimple(receiver, debt, amount, params, 0).
 *   Aave passes initiator = that EOA, which must equal the on-chain `executor`.
 */
import {
  encodeAbiParameters,
  decodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";

export const RECEIVER_V3_VERSION = 3n;
export const RECEIVER_V3_LAYOUT_ID = keccak256(toBytes("BOT21_RECEIVER_V3_7FIELD"));
export const RECEIVER_V3_ROUTE_AAVE = 0;

const paramsAbi = [
  { name: "routeType", type: "uint8" },
  { name: "collateral", type: "address" },
  { name: "debt", type: "address" },
  { name: "user", type: "address" },
  { name: "debtToCover", type: "uint256" },
  { name: "minCollateralOut", type: "uint256" },
  { name: "receiveAToken", type: "bool" },
] as const;

export interface LiquidationReceiverV3Params {
  readonly collateral: Address;
  readonly debt: Address;
  readonly user: Address;
  readonly debtToCover: bigint;
  /** Minimum debt-token amount out of the swap (historical name: minCollateralOut). */
  readonly minCollateralOut: bigint;
  readonly receiveAToken?: boolean;
  /** Must be 0. Defaults to RECEIVER_V3_ROUTE_AAVE. */
  readonly routeType?: number;
}

export function encodeLiquidationReceiverV3Params(
  route: LiquidationReceiverV3Params,
): Hex {
  const routeType = route.routeType ?? RECEIVER_V3_ROUTE_AAVE;
  if (routeType !== RECEIVER_V3_ROUTE_AAVE) {
    throw new Error(`LiquidationReceiverV3 only supports routeType 0 (got ${routeType})`);
  }
  if (route.receiveAToken === true) {
    throw new Error("LiquidationReceiverV3 requires receiveAToken=false");
  }
  return encodeAbiParameters(paramsAbi, [
    RECEIVER_V3_ROUTE_AAVE,
    route.collateral,
    route.debt,
    route.user,
    route.debtToCover,
    route.minCollateralOut,
    false,
  ]);
}

export function decodeLiquidationReceiverV3Params(data: Hex): LiquidationReceiverV3Params & {
  readonly routeType: number;
  readonly receiveAToken: boolean;
} {
  const [routeType, collateral, debt, user, debtToCover, minCollateralOut, receiveAToken] =
    decodeAbiParameters(paramsAbi, data);
  return {
    routeType: Number(routeType),
    collateral,
    debt,
    user,
    debtToCover,
    minCollateralOut,
    receiveAToken,
  };
}

/** Minimal ABI surface used by readiness / cutover checks. */
export const liquidationFlashReceiverV3Abi = [
  {
    type: "function",
    name: "receiverVersion",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "layoutId",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "executor",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "profitRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "poolFee",
    stateMutability: "view",
    inputs: [
      { name: "collateral", type: "address" },
      { name: "debt", type: "address" },
    ],
    outputs: [{ type: "uint24" }],
  },
  {
    type: "function",
    name: "liquidate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateral", type: "address" },
      { name: "debt", type: "address" },
      { name: "user", type: "address" },
      { name: "debtToCover", type: "uint256" },
      { name: "minCollateralOut", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setPoolFee",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateral", type: "address" },
      { name: "debt", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "LiquidationExecuted",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "collateral", type: "address", indexed: true },
      { name: "debt", type: "address", indexed: true },
      { name: "debtCovered", type: "uint256", indexed: false },
      { name: "collateralReceived", type: "uint256", indexed: false },
      { name: "profit", type: "uint256", indexed: false },
    ],
  },
] as const;

export function assertReceiverV3Identity(args: {
  readonly version: bigint;
  readonly layoutId: Hex;
}): void {
  if (args.version !== RECEIVER_V3_VERSION) {
    throw new Error(`unexpected receiverVersion ${args.version} (want ${RECEIVER_V3_VERSION})`);
  }
  if (args.layoutId.toLowerCase() !== RECEIVER_V3_LAYOUT_ID.toLowerCase()) {
    throw new Error(`unexpected layoutId ${args.layoutId}`);
  }
}
