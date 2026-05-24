import type { Address, PublicClient } from "viem";
import { getChainConfig, type SupportedChain } from "../config/chains";

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
}

/**
 * Verifies the deployed receiver is non-empty, exposes the expected version, is wired to the chain Aave pool,
 * and uses the configured DEX router (prevents mis-deployed or forked bytecode).
 */
export async function assertLiquidationReceiverReadiness(
  client: Pick<PublicClient, "getBytecode" | "readContract">,
  input: LiquidationReceiverReadinessInput,
): Promise<void> {
  const bytecode = await client.getBytecode({ address: input.receiver });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`LIQUIDATION_RECEIVER_ADDRESS has no on-chain code at ${input.receiver} (${input.chain})`);
  }

  const version = await client.readContract({
    address: input.receiver,
    abi: liquidationFlashReceiverAbi,
    functionName: "receiverVersion",
  });
  if (version !== 1n) {
    throw new Error(`Liquidation receiver version mismatch: expected 1, got ${version.toString()}`);
  }

  const expectedPool = getChainConfig(input.chain).aave.pool;
  const boundPool = await client.readContract({
    address: input.receiver,
    abi: liquidationFlashReceiverAbi,
    functionName: "aavePool",
  });
  if (boundPool.toLowerCase() !== expectedPool.toLowerCase()) {
    throw new Error(
      `Liquidation receiver is bound to the wrong Aave pool on ${input.chain}: expected ${expectedPool}, got ${boundPool}`,
    );
  }

  const boundRouter = await client.readContract({
    address: input.receiver,
    abi: liquidationFlashReceiverAbi,
    functionName: "swapRouter",
  });
  if (boundRouter.toLowerCase() !== input.expectedSwapRouter.toLowerCase()) {
    throw new Error(
      `Liquidation receiver swap router mismatch on ${input.chain}: expected ${input.expectedSwapRouter}, got ${boundRouter}`,
    );
  }
}
