import "dotenv/config";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { base } from "viem/chains";
import { describe, expect, it } from "vitest";
import { getChainConfig } from "../../src/config/chains";
import { getDexesForChain } from "../../src/config/dexRegistry";
import {
  fetchOnChainLiquidationReceiverVersion,
  parseExpectedLiquidationReceiverVersion,
  verifyLiquidationReceiverReadiness,
} from "../../src/production/liquidationReceiverReadiness";

const rpcUrl = process.env.RPC_URL
  ?? process.env.EXECUTION_RPC_URL_PRIMARY
  ?? process.env.DEPLOY_RECEIVER_RPC_URL;
const receiverRaw = process.env.LIQUIDATION_RECEIVER_ADDRESS?.trim();
const receiver = receiverRaw !== undefined && isAddress(receiverRaw) ? receiverRaw as Address : undefined;
const describeLive = rpcUrl === undefined || rpcUrl.trim() === "" || receiver === undefined
  ? describe.skip
  : describe;

describeLive("liquidation receiver readiness (Base mainnet fork via RPC)", () => {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl!) });

  it("reads on-chain receiverVersion via eth_call", async () => {
    const onChainVersion = await fetchOnChainLiquidationReceiverVersion(client, receiver!);
    expect(onChainVersion).toBeGreaterThanOrEqual(1n);
    // eslint-disable-next-line no-console
    console.info("liquidation_receiver_on_chain_version", {
      receiver,
      onChainVersion: onChainVersion.toString(),
    });
  }, 60_000);

  it("passes full readiness when LIQUIDATION_RECEIVER_EXPECTED_VERSION matches deployed bytecode", async () => {
    const expectedVersion = parseExpectedLiquidationReceiverVersion(
      process.env.LIQUIDATION_RECEIVER_EXPECTED_VERSION,
    );
    const registryUniswap = getDexesForChain("base").find((dex) => dex.name === "UniswapV3");
    const expectedSwapRouter = process.env.LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER?.trim() as Address | undefined
      ?? registryUniswap?.router;
    if (expectedSwapRouter === undefined) {
      throw new Error("Set LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER or configure UniswapV3 in dexRegistry");
    }

    const result = await verifyLiquidationReceiverReadiness(client, {
      chain: "base",
      receiver: receiver!,
      expectedSwapRouter,
      expectedVersion,
    });

    expect(result.onChainVersion).toBe(expectedVersion);
    expect(result.boundPool.toLowerCase()).toBe(getChainConfig("base").aave.pool.toLowerCase());
    // eslint-disable-next-line no-console
    console.info("liquidation_receiver_readiness_ok", {
      receiver: result.receiver,
      onChainVersion: result.onChainVersion.toString(),
      expectedVersion: result.expectedVersion.toString(),
      boundPool: result.boundPool,
      boundRouter: result.boundRouter,
    });
  }, 60_000);
});
