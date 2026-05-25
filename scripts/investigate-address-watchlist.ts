/**
 * Investigates one borrower on Base: on-chain HF, sweep layers, watchlist membership.
 * Usage: npx ts-node scripts/investigate-address-watchlist.ts 0x...
 */
import "dotenv/config";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import { BoundedWatchlist } from "../src/monitors/boundedWatchlist";
import { EventDrivenWatchlist } from "../src/monitors/eventDrivenWatchlist";
import {
  filterAddressesForSweep,
  sweepHealthFactors,
} from "../src/monitors/healthFactorSweep";
import { createBlockCursor } from "../src/utils/blockCursor";

const POOL = getChainConfig("base").aave.pool;
const WAD = 1_000_000_000_000_000_000n;

function resolveEnvMinDebtUsd(): number {
  const raw = process.env.MIN_LIQUIDATION_DEBT_USD?.trim();
  if (raw !== undefined && raw.length > 0) {
    return Number(raw);
  }
  return Math.max(Number(process.env.MIN_PROFIT_USD ?? "10"), 50);
}

async function main(): Promise<void> {
  const target = process.argv[2]?.toLowerCase() as Address | undefined;
  if (target === undefined || !/^0x[a-f0-9]{40}$/.test(target)) {
    throw new Error("Usage: npx ts-node scripts/investigate-address-watchlist.ts 0x<address>");
  }

  const rpcUrl = process.env.RPC_URL ?? process.env.EXECUTION_RPC_URL_PRIMARY;
  if (rpcUrl === undefined) {
    throw new Error("Set RPC_URL");
  }

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) }) as unknown as PublicClient;
  const minDebtUsd = resolveEnvMinDebtUsd();
  const minDebtBase = BigInt(Math.trunc(minDebtUsd * 1e8));
  const batchSize = Number(process.env.MULTICALL_BATCH_SIZE ?? "250");

  const sweepHits = await sweepHealthFactors([target], {
    client,
    poolAddress: POOL,
    batchSize,
    minDebtBase,
  });

  const watchlist = new BoundedWatchlist();
  const cursor = await createBlockCursor("base", {
    ...(process.env.REDIS_URL === undefined ? {} : { redisUrl: process.env.REDIS_URL }),
  });
  const eventWatchlist = new EventDrivenWatchlist({
    chain: "base",
    poolAddress: POOL,
    readClient: client,
    watchlist,
    cursor,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    coldStartLookbackBlocks: BigInt(process.env.COLD_START_LOOKBACK_BLOCKS ?? "50000"),
  });
  await eventWatchlist.coldStartFromLogs(50_000n);
  const inWatchlist = watchlist.addresses().map((a) => a.toLowerCase()).includes(target);
  const blockNumber = await client.getBlockNumber();
  const tierTargets = filterAddressesForSweep(watchlist, blockNumber, 100n);
  const inTierSweep = tierTargets.map((a) => a.toLowerCase()).includes(target);

  console.log(JSON.stringify({
    msg: "investigate_address_complete",
    address: target,
    minDebtUsd,
    minDebtBase: minDebtBase.toString(),
    sweepLiquidatable: sweepHits.length > 0,
    sweepDetail: sweepHits[0] === undefined
      ? null
      : {
        healthFactor: (Number(sweepHits[0].healthFactor) / 1e18).toString(),
        totalDebtBase: sweepHits[0].totalDebtBase.toString(),
        debtUsd: (Number(sweepHits[0].totalDebtBase) / 1e8).toFixed(2),
      },
    watchlistSize: watchlist.size(),
    inWatchlistAfterColdStart: inWatchlist,
    inTieredSweepTargets: inTierSweep,
    diagnosis: !inWatchlist
      ? "SEED_COVERAGE_GAP"
      : sweepHits.length === 0
        ? "IN_WATCHLIST_BUT_SWEEP_MISSED"
        : "WATCHLIST_AND_SWEEP_OK",
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
