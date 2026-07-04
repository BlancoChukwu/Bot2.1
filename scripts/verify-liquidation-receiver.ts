/**
 * On-chain liquidation receiver verification (eth_call version + pool + router).
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.event-purity-production npx ts-node scripts/verify-liquidation-receiver.ts
 *   DOTENV_CONFIG_PATH=.env.production LIQUIDATION_RECEIVER_ADDRESS=0x... npx ts-node scripts/verify-liquidation-receiver.ts
 */
import "dotenv/config";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import { getDexesForChain } from "../src/config/dexRegistry";
import {
  parseExpectedLiquidationReceiverVersion,
  verifyLiquidationReceiverReadiness,
} from "../src/production/liquidationReceiverReadiness";

function resolveRpcUrl(): string {
  const candidates = [
    process.env.EXECUTION_RPC_URL_PRIMARY,
    process.env.RPC_URL,
    process.env.DEPLOY_RECEIVER_RPC_URL,
    process.env.EXECUTION_RPC_URL_FALLBACKS?.split(",")[0],
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  throw new Error("Set RPC_URL, EXECUTION_RPC_URL_PRIMARY, or DEPLOY_RECEIVER_RPC_URL");
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

function resolveExpectedSwapRouter(): Address {
  const fromEnv = process.env.LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!isAddress(fromEnv)) {
      throw new Error(`LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER is not a valid address: ${fromEnv}`);
    }
    return fromEnv;
  }
  const registryUniswap = getDexesForChain("base").find((dex) => dex.name === "UniswapV3");
  if (registryUniswap === undefined) {
    throw new Error("Set LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER or configure UniswapV3 in dexRegistry");
  }
  return registryUniswap.router;
}

async function main(): Promise<void> {
  const receiver = resolveReceiverAddress();
  const expectedVersion = parseExpectedLiquidationReceiverVersion(
    process.env.LIQUIDATION_RECEIVER_EXPECTED_VERSION,
  );
  const expectedSwapRouter = resolveExpectedSwapRouter();
  const rpcUrl = resolveRpcUrl();
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const result = await verifyLiquidationReceiverReadiness(client, {
    chain: "base",
    receiver,
    expectedSwapRouter,
    expectedVersion,
  });

  console.log(JSON.stringify({
    event: "liquidation_receiver_verified",
    chain: result.chain,
    receiver: result.receiver,
    onChainVersion: result.onChainVersion.toString(),
    expectedVersion: result.expectedVersion.toString(),
    boundPool: result.boundPool,
    expectedPool: getChainConfig("base").aave.pool,
    boundRouter: result.boundRouter,
    expectedSwapRouter,
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
  }, null, 2));
  process.exit(1);
});
