import "dotenv/config";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getChainConfig } from "../../src/config/chains";
import { DEFAULT_LIQUIDATION_RECEIVER_VERSION, liquidationFlashReceiverAbi } from "../../src/production/liquidationReceiverReadiness";
import {
  createManagedAnvilFork,
  resolveForkSourceRpc,
  type ManagedAnvilFork,
} from "./helpers/baseAnvilFork";
import {
  assertReceiverVersion,
  createForkPublicClient,
  deployLiquidationFlashReceiver,
  encodeExecuteOperationParams,
  extractRevertMessage,
  findHealthyBorrower,
  findRecentLiquidationCase,
  loadLiquidationFlashReceiverArtifact,
  readHealthFactor,
  simulateExecuteOperation,
} from "./helpers/liquidationReceiverForkHarness";

const forkSourceRpc = resolveForkSourceRpc();
if (forkSourceRpc === undefined) {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({
    event: "receiver_fork_tests_skipped",
    reason: "missing_fork_rpc",
    hint: "Run via npm run test:receiver-fork with DOTENV_CONFIG_PATH pointing at a profile that sets RPC_URL",
  }));
}
const describeFork = forkSourceRpc === undefined ? describe.skip : describe;

describeFork("LiquidationFlashReceiver v2 HF guard (Base anvil fork)", () => {
  const artifact = loadLiquidationFlashReceiverArtifact();
  const pool = getChainConfig("base").aave.pool;
  let latestFork: ManagedAnvilFork;
  let latestClient: ReturnType<typeof createForkPublicClient>;
  let receiver: Awaited<ReturnType<typeof deployLiquidationFlashReceiver>>;

  beforeAll(async () => {
    latestFork = await createManagedAnvilFork({ forkUrl: forkSourceRpc! });
    latestClient = createForkPublicClient(latestFork.rpcUrl);
    receiver = await deployLiquidationFlashReceiver(latestFork.rpcUrl, artifact);
    await assertReceiverVersion(latestClient, receiver, DEFAULT_LIQUIDATION_RECEIVER_VERSION);
  }, 120_000);

  afterAll(async () => {
    await latestFork?.stop();
  }, 30_000);

  it("deploys receiver v2 bytecode on the fork", async () => {
    const version = await latestClient.readContract({
      address: receiver,
      abi: liquidationFlashReceiverAbi,
      functionName: "receiverVersion",
    });
    expect(version).toBe(2n);
  });

  it("reverts HF_NOT_LIQUIDATABLE when HF >= 1e18", async () => {
    const healthy = await findHealthyBorrower(latestClient, pool);
    const debtAsset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const collateralAsset = "0x4200000000000000000000000000000000000006";
    const params = encodeExecuteOperationParams({
      collateralAsset,
      debtAsset,
      user: healthy.user,
      debtToCover: 1_000_000n,
      receiveAToken: false,
    });

    await expect(
      simulateExecuteOperation({
        client: latestClient,
        rpcUrl: latestFork.rpcUrl,
        receiver,
        pool,
        debtAsset,
        amount: 1_000_000n,
        premium: 0n,
        params,
        artifact,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = extractRevertMessage(error);
      return message.includes("HF_NOT_LIQUIDATABLE");
    });
  }, 60_000);

  it("passes the HF guard for a historically liquidatable position (fork block - 1)", async () => {
    const liquidationCase = await findRecentLiquidationCase(latestClient, pool);
    expect(liquidationCase.healthFactor).toBeLessThan(1_000_000_000_000_000_000n);

    const historicalFork = await createManagedAnvilFork({
      forkUrl: forkSourceRpc!,
      port: Number(process.env.ANVIL_PORT ?? "8545") + 1,
      blockNumber: liquidationCase.blockNumber > 0n ? liquidationCase.blockNumber - 1n : 0n,
    });
    try {
      const historicalClient = createForkPublicClient(historicalFork.rpcUrl);
      const historicalReceiver = await deployLiquidationFlashReceiver(historicalFork.rpcUrl, artifact);
      const hfAtFork = await readHealthFactor(historicalClient, pool, liquidationCase.user);
      expect(hfAtFork).toBeLessThan(1_000_000_000_000_000_000n);

      const params = encodeExecuteOperationParams({
        collateralAsset: liquidationCase.collateralAsset,
        debtAsset: liquidationCase.debtAsset,
        user: liquidationCase.user,
        debtToCover: liquidationCase.debtToCover,
        receiveAToken: liquidationCase.receiveAToken,
      });

      try {
        await simulateExecuteOperation({
          client: historicalClient,
          rpcUrl: historicalFork.rpcUrl,
          receiver: historicalReceiver,
          pool,
          debtAsset: liquidationCase.debtAsset,
          amount: liquidationCase.debtToCover,
          premium: 0n,
          params,
          artifact,
        });
      } catch (error) {
        const message = extractRevertMessage(error);
        expect(message).not.toContain("HF_NOT_LIQUIDATABLE");
      }
    } finally {
      await historicalFork.stop();
    }
  }, 180_000);
});
