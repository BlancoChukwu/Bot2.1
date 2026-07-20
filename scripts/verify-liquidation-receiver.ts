/**
 * On-chain liquidation receiver verification for Base mainnet OR Base Sepolia.
 *
 * Usage (mainnet):
 *   DOTENV_CONFIG_PATH=.env.event-purity-production npx ts-node scripts/verify-liquidation-receiver.ts
 *
 * Usage (Base Sepolia):
 *   VERIFY_CHAIN=base-sepolia \
 *   DEPLOY_RECEIVER_RPC_URL=https://base-sepolia.g.alchemy.com/v2/<key> \
 *   LIQUIDATION_RECEIVER_ADDRESS=0x... \
 *   LIQUIDATION_AUTHORIZED_INITIATOR=0x... \
 *   LIQUIDATION_SWAP_SLIPPAGE_BPS=200 \
 *   LIQUIDATION_RECEIVER_EXPECTED_VERSION=5 \
 *   npx ts-node scripts/verify-liquidation-receiver.ts
 */
import "dotenv/config";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import { getDexesForChain } from "../src/config/dexRegistry";
import {
  liquidationFlashReceiverAbi,
  parseExpectedLiquidationReceiverVersion,
  verifyLiquidationReceiverReadiness,
} from "../src/production/liquidationReceiverReadiness";

const AAVE_POOL_BASE_SEPOLIA = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27" as Address;
const UNISWAP_SWAP_ROUTER_02_BASE_SEPOLIA = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Address;

type VerifyChain = "base" | "base-sepolia";

function resolveVerifyChain(): VerifyChain {
  const raw = (process.env.VERIFY_CHAIN ?? process.env.LIQUIDATION_VERIFY_CHAIN ?? "base").trim().toLowerCase();
  if (raw === "base-sepolia" || raw === "basesepolia" || raw === "sepolia") {
    return "base-sepolia";
  }
  if (raw === "base") {
    return "base";
  }
  throw new Error(`VERIFY_CHAIN must be "base" or "base-sepolia", got "${raw}"`);
}

function resolveRpcUrl(): string {
  const candidates = [
    process.env.DEPLOY_RECEIVER_RPC_URL,
    process.env.BASE_SEPOLIA_RPC_URL,
    process.env.EXECUTION_RPC_URL_PRIMARY,
    process.env.RPC_URL,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  throw new Error("Set RPC_URL, EXECUTION_RPC_URL_PRIMARY, DEPLOY_RECEIVER_RPC_URL, or BASE_SEPOLIA_RPC_URL");
}

function resolveReceiverAddress(): Address {
  const raw = process.env.LIQUIDATION_RECEIVER_ADDRESS?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new Error("Set LIQUIDATION_RECEIVER_ADDRESS");
  }
  if (!isAddress(raw)) {
    throw new Error(`LIQUIDATION_RECEIVER_ADDRESS is not a valid address: ${raw}`);
  }
  return raw;
}

function resolveExpectedSwapRouter(chain: VerifyChain): Address {
  const fromEnv = process.env.LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!isAddress(fromEnv)) {
      throw new Error(`LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER is not a valid address: ${fromEnv}`);
    }
    return fromEnv;
  }
  if (chain === "base-sepolia") {
    return UNISWAP_SWAP_ROUTER_02_BASE_SEPOLIA;
  }
  const registryUniswap = getDexesForChain("base").find((dex) => dex.name === "UniswapV3");
  if (registryUniswap === undefined) {
    throw new Error("Set LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER or configure UniswapV3 in dexRegistry");
  }
  return registryUniswap.router;
}

function resolveExpectedPool(chain: VerifyChain): Address {
  if (chain === "base-sepolia") {
    return AAVE_POOL_BASE_SEPOLIA;
  }
  return getChainConfig("base").aave.pool;
}

function resolveExpectedAuthorizedInitiator(): Address | undefined {
  const raw = process.env.LIQUIDATION_AUTHORIZED_INITIATOR?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (!isAddress(raw)) {
    throw new Error(`LIQUIDATION_AUTHORIZED_INITIATOR is not a valid address: ${raw}`);
  }
  return raw;
}

function resolveExpectedSwapSlippageBps(): bigint | undefined {
  const raw = process.env.LIQUIDATION_SWAP_SLIPPAGE_BPS?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`LIQUIDATION_SWAP_SLIPPAGE_BPS must be a non-negative integer, got "${raw}"`);
  }
  return BigInt(raw);
}

function resolveExpectedOwner(): Address | undefined {
  const raw = process.env.LIQUIDATION_RECEIVER_EXPECTED_OWNER?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (!isAddress(raw)) {
    throw new Error(`LIQUIDATION_RECEIVER_EXPECTED_OWNER is not a valid address: ${raw}`);
  }
  return raw;
}

async function main(): Promise<void> {
  const verifyChain = resolveVerifyChain();
  const receiver = resolveReceiverAddress();
  const expectedVersion = parseExpectedLiquidationReceiverVersion(
    process.env.LIQUIDATION_RECEIVER_EXPECTED_VERSION,
  );
  const expectedSwapRouter = resolveExpectedSwapRouter(verifyChain);
  const expectedPool = resolveExpectedPool(verifyChain);
  const expectedAuthorizedInitiator = resolveExpectedAuthorizedInitiator();
  const expectedSwapSlippageBps = resolveExpectedSwapSlippageBps();
  const expectedOwner = resolveExpectedOwner();
  const rpcUrl = resolveRpcUrl();
  const viemChain = verifyChain === "base-sepolia" ? baseSepolia : base;
  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

  const chainId = await client.getChainId();
  if (verifyChain === "base-sepolia" && chainId !== baseSepolia.id) {
    throw new Error(`Expected Base Sepolia chainId ${baseSepolia.id}, got ${chainId}`);
  }
  if (verifyChain === "base" && chainId !== base.id) {
    throw new Error(`Expected Base mainnet chainId ${base.id}, got ${chainId}`);
  }

  let result:
    | Awaited<ReturnType<typeof verifyLiquidationReceiverReadiness>>
    | undefined;
  if (verifyChain === "base") {
    result = await verifyLiquidationReceiverReadiness(client, {
      chain: "base",
      receiver,
      expectedSwapRouter,
      expectedVersion,
      expectedAuthorizedInitiator,
      expectedSwapSlippageBps,
    });
  } else {
    // Sepolia: readiness helper is mainnet-chain typed; do the same checks inline.
    const bytecode = await client.getBytecode({ address: receiver });
    if (bytecode === undefined || bytecode === "0x") {
      throw new Error(`LIQUIDATION_RECEIVER_ADDRESS has no on-chain code at ${receiver} (base-sepolia)`);
    }
    const onChainVersion = await client.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "receiverVersion",
    });
    if (onChainVersion !== expectedVersion) {
      throw new Error(
        `Liquidation receiver version mismatch at ${receiver} (base-sepolia): `
        + `expected ${expectedVersion.toString()}, on-chain ${onChainVersion.toString()}`,
      );
    }
    const boundPool = await client.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "aavePool",
    });
    if (boundPool.toLowerCase() !== expectedPool.toLowerCase()) {
      throw new Error(
        `Liquidation receiver pool mismatch at ${receiver}: expected ${expectedPool}, got ${boundPool}`,
      );
    }
    const boundRouter = await client.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "swapRouter",
    });
    if (boundRouter.toLowerCase() !== expectedSwapRouter.toLowerCase()) {
      throw new Error(
        `Liquidation receiver swap router mismatch at ${receiver}: expected ${expectedSwapRouter}, got ${boundRouter}`,
      );
    }
    const boundAuthorizedInitiator = await client.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "authorizedInitiator",
    });
    if (
      expectedAuthorizedInitiator !== undefined
      && boundAuthorizedInitiator.toLowerCase() !== expectedAuthorizedInitiator.toLowerCase()
    ) {
      throw new Error(
        `Liquidation receiver authorizedInitiator mismatch at ${receiver}: `
        + `expected ${expectedAuthorizedInitiator}, got ${boundAuthorizedInitiator}`,
      );
    }
    const boundSwapSlippageBps = await client.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "swapSlippageBps",
    });
    if (
      expectedSwapSlippageBps !== undefined
      && boundSwapSlippageBps !== expectedSwapSlippageBps
    ) {
      throw new Error(
        `Liquidation receiver swapSlippageBps mismatch at ${receiver}: `
        + `expected ${expectedSwapSlippageBps.toString()}, got ${boundSwapSlippageBps.toString()}`,
      );
    }
    result = {
      chain: "base",
      receiver,
      onChainVersion,
      expectedVersion,
      boundPool,
      boundRouter,
      boundAuthorizedInitiator,
      boundSwapSlippageBps,
    };
  }

  const boundOwner = await client.readContract({
    address: receiver,
    abi: [
      {
        type: "function",
        name: "owner",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
      },
    ] as const,
    functionName: "owner",
  });
  if (expectedOwner !== undefined && boundOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error(
      `Liquidation receiver owner mismatch at ${receiver}: expected ${expectedOwner}, got ${boundOwner}`,
    );
  }

  console.log(JSON.stringify({
    event: "liquidation_receiver_verified",
    verifyChain,
    chainId,
    receiver: result.receiver,
    onChainVersion: result.onChainVersion.toString(),
    expectedVersion: result.expectedVersion.toString(),
    boundOwner,
    expectedOwner: expectedOwner ?? null,
    boundPool: result.boundPool,
    expectedPool,
    boundRouter: result.boundRouter,
    expectedSwapRouter,
    boundAuthorizedInitiator: result.boundAuthorizedInitiator,
    expectedAuthorizedInitiator: expectedAuthorizedInitiator ?? null,
    boundSwapSlippageBps: result.boundSwapSlippageBps.toString(),
    expectedSwapSlippageBps: expectedSwapSlippageBps?.toString() ?? null,
    ownerEqualsInitiator:
      result.boundAuthorizedInitiator.toLowerCase() === boundOwner.toLowerCase(),
    rpcHost: new URL(rpcUrl).host,
    status: "ok",
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: "liquidation_receiver_verification_failed",
    error: error instanceof Error ? error.message : String(error),
    receiver: process.env.LIQUIDATION_RECEIVER_ADDRESS ?? null,
    expectedVersion: process.env.LIQUIDATION_RECEIVER_EXPECTED_VERSION ?? null,
    verifyChain: process.env.VERIFY_CHAIN ?? "base",
  }, null, 2));
  process.exit(1);
});
