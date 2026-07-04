import type { Address, PublicClient } from "viem";
import { getChainConfig, type SupportedChain } from "../config/chains";

/**
 * Default when `LIQUIDATION_RECEIVER_EXPECTED_VERSION` is unset.
 * Must match `RECEIVER_VERSION` in `contracts/LiquidationFlashReceiver.sol` at deploy time.
 */
export const DEFAULT_LIQUIDATION_RECEIVER_VERSION = 2n;

/** @deprecated Use DEFAULT_LIQUIDATION_RECEIVER_VERSION */
export const EXPECTED_LIQUIDATION_RECEIVER_VERSION = DEFAULT_LIQUIDATION_RECEIVER_VERSION;

/** Minimal ABI for automated startup checks (must match `contracts/LiquidationFlashReceiver.sol`). */
export const liquidationFlashReceiverAbi = [
  {
    type: "function",
    name: "receiverVersion",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "RECEIVER_VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "aavePool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "swapRouter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export interface LiquidationReceiverReadinessInput {
  readonly chain: SupportedChain;
  readonly receiver: Address;
  readonly expectedSwapRouter: Address;
  /** Configured expectation (`LIQUIDATION_RECEIVER_EXPECTED_VERSION`); defaults to compile-time default. */
  readonly expectedVersion?: bigint;
}

export interface LiquidationReceiverReadinessResult {
  readonly chain: SupportedChain;
  readonly receiver: Address;
  readonly onChainVersion: bigint;
  readonly expectedVersion: bigint;
  readonly boundPool: Address;
  readonly boundRouter: Address;
}

export function parseExpectedLiquidationReceiverVersion(
  value: string | undefined,
  fallback: bigint = DEFAULT_LIQUIDATION_RECEIVER_VERSION,
): bigint {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return fallback;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`LIQUIDATION_RECEIVER_EXPECTED_VERSION must be a non-negative integer, got "${trimmed}"`);
  }
  const parsed = BigInt(trimmed);
  if (parsed < 1n) {
    throw new Error(`LIQUIDATION_RECEIVER_EXPECTED_VERSION must be >= 1, got ${parsed.toString()}`);
  }
  return parsed;
}

/**
 * Fetches the deployed receiver version via eth_call (`receiverVersion()`).
 * Falls back to the `RECEIVER_VERSION` public constant when the getter is absent (legacy bytecode).
 */
export async function fetchOnChainLiquidationReceiverVersion(
  client: Pick<PublicClient, "readContract">,
  receiver: Address,
): Promise<bigint> {
  try {
    return await client.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "receiverVersion",
    });
  } catch (getterError) {
    try {
      return await client.readContract({
        address: receiver,
        abi: liquidationFlashReceiverAbi,
        functionName: "RECEIVER_VERSION",
      });
    } catch {
      const reason = getterError instanceof Error ? getterError.message : String(getterError);
      throw new Error(`Could not read liquidation receiver version at ${receiver}: ${reason}`);
    }
  }
}

/**
 * Verifies deployed bytecode matches configured expectations (version, pool, router).
 * Returns on-chain values for structured startup logging.
 */
export async function verifyLiquidationReceiverReadiness(
  client: Pick<PublicClient, "getBytecode" | "readContract">,
  input: LiquidationReceiverReadinessInput,
): Promise<LiquidationReceiverReadinessResult> {
  const expectedVersion = input.expectedVersion ?? DEFAULT_LIQUIDATION_RECEIVER_VERSION;
  const bytecode = await client.getBytecode({ address: input.receiver });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`LIQUIDATION_RECEIVER_ADDRESS has no on-chain code at ${input.receiver} (${input.chain})`);
  }

  const onChainVersion = await fetchOnChainLiquidationReceiverVersion(client, input.receiver);
  if (onChainVersion !== expectedVersion) {
    throw new Error(
      `Liquidation receiver version mismatch at ${input.receiver} (${input.chain}): `
      + `expected ${expectedVersion.toString()} (LIQUIDATION_RECEIVER_EXPECTED_VERSION), `
      + `on-chain ${onChainVersion.toString()}. `
      + "Redeploy the receiver or set LIQUIDATION_RECEIVER_EXPECTED_VERSION to match deployed bytecode.",
    );
  }

  const expectedPool = getChainConfig(input.chain).aave.pool;
  const boundPool = await client.readContract({
    address: input.receiver,
    abi: liquidationFlashReceiverAbi,
    functionName: "aavePool",
  });
  if (boundPool.toLowerCase() !== expectedPool.toLowerCase()) {
    throw new Error(
      `Liquidation receiver is bound to the wrong Aave pool on ${input.chain} at ${input.receiver}: `
      + `expected ${expectedPool}, got ${boundPool}`,
    );
  }

  const boundRouter = await client.readContract({
    address: input.receiver,
    abi: liquidationFlashReceiverAbi,
    functionName: "swapRouter",
  });
  if (boundRouter.toLowerCase() !== input.expectedSwapRouter.toLowerCase()) {
    throw new Error(
      `Liquidation receiver swap router mismatch on ${input.chain} at ${input.receiver}: `
      + `expected ${input.expectedSwapRouter}, got ${boundRouter}`,
    );
  }

  return {
    chain: input.chain,
    receiver: input.receiver,
    onChainVersion,
    expectedVersion,
    boundPool,
    boundRouter,
  };
}

/**
 * Hard gate: throws on mismatch between configured expectations and deployed bytecode.
 */
export async function assertLiquidationReceiverReadiness(
  client: Pick<PublicClient, "getBytecode" | "readContract">,
  input: LiquidationReceiverReadinessInput,
): Promise<LiquidationReceiverReadinessResult> {
  return verifyLiquidationReceiverReadiness(client, input);
}
