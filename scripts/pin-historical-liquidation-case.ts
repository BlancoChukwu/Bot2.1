/**
 * Discover one Base Aave historical underwater liquidation and write a pinned fixture.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.event-purity-production npx tsx scripts/pin-historical-liquidation-case.ts
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { getChainConfig } from "../src/config/chains";
import { findHistoricalLiquidationCase } from "../test/integration/helpers/liquidationReceiverForkHarness";

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

function resolveRpc(): string {
  const candidates = [
    process.env.BASE_FORK_RPC_URL,
    process.env.FORK_RPC_URL,
    process.env.EXECUTION_RPC_URL_PRIMARY,
    process.env.RPC_URL,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  throw new Error("Set RPC_URL for Base fork discovery");
}

async function main(): Promise<void> {
  const rpcUrl = resolveRpc();
  const pool = getChainConfig("base").aave.pool;
  const liquidationCase = await findHistoricalLiquidationCase(rpcUrl, pool, 5_000_000n, {
    collateralAsset: WETH,
    debtAsset: USDC,
    minDebtToCover: 50_000_000_000n, // 50_000 USDC — matches fork happy-path sizing
  });

  const fixture = {
    chain: "base",
    pool,
    user: liquidationCase.user,
    collateralAsset: liquidationCase.collateralAsset,
    debtAsset: liquidationCase.debtAsset,
    debtToCover: liquidationCase.debtToCover.toString(),
    liquidatedCollateralAmount: liquidationCase.liquidatedCollateralAmount.toString(),
    receiveAToken: liquidationCase.receiveAToken,
    blockNumber: liquidationCase.blockNumber.toString(),
    snapshotBlock: liquidationCase.snapshotBlock.toString(),
    healthFactor: liquidationCase.healthFactor.toString(),
    pinnedAt: new Date().toISOString(),
    note: "Pinned historical underwater Base Aave liquidation for production-encoding fork E2E",
  };

  const outPath = join(process.cwd(), "test", "fixtures", "historical-liquidation-base.json");
  writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: "historical_liquidation_pinned", path: outPath, ...fixture }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
