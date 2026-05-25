/**
 * Probes multicall HF sweep batch sizes on Base mainnet RPC.
 * Usage: CHAIN=base npm run probe:multicall-base
 */
import "dotenv/config";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import { BoundedWatchlist } from "../src/monitors/boundedWatchlist";
import { EventDrivenWatchlist } from "../src/monitors/eventDrivenWatchlist";
import { sweepHealthFactors } from "../src/monitors/healthFactorSweep";
import { ViemAaveV3Protocol } from "../src/protocols/aaveV3";
import { createBlockCursor } from "../src/utils/blockCursor";

const TARGET_MS = 400;
const BATCH_SIZES = [500, 250] as const;
const POOL = getChainConfig("base").aave.pool;

function resolveSubgraphUrl(): string {
  const explicit = process.env.AAVE_SUBGRAPH_URL?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const baseOnly = process.env.BASE_AAVE_SUBGRAPH_URL?.trim();
  if (baseOnly !== undefined && baseOnly.length > 0) {
    return baseOnly;
  }
  throw new Error("Set AAVE_SUBGRAPH_URL or BASE_AAVE_SUBGRAPH_URL");
}

function createGraphClient(url: string) {
  return {
    request: async <T>(query: string, variables: Record<string, number | string>): Promise<T> => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const payload = await response.json() as { data?: T; errors?: unknown };
      if (!response.ok || payload.errors !== undefined) {
        throw new Error(`Subgraph error HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
      }
      return payload.data as T;
    },
  };
}

async function loadAddressesFromRpc(client: PublicClient, limit: number): Promise<Address[]> {
  const watchlist = new BoundedWatchlist();
  const cursor = await createBlockCursor("base");
  const eventWatchlist = new EventDrivenWatchlist({
    chain: "base",
    poolAddress: POOL,
    readClient: client,
    watchlist,
    cursor,
    logger: { info: console.log, warn: console.warn, error: console.error },
    coldStartLookbackBlocks: 50_000n,
  });
  await eventWatchlist.coldStartFromLogs(50_000n);
  return watchlist.addresses().slice(0, limit) as Address[];
}

async function loadAddresses(protocol: ViemAaveV3Protocol, client: PublicClient, limit: number): Promise<Address[]> {
  try {
    const all = await protocol.listBorrowerAddresses?.();
    if (all !== undefined && all.length > 0) {
      return [...all].slice(0, limit);
    }
  } catch (error) {
    console.warn("Subgraph borrower load failed; falling back to RPC log seed", String(error));
  }
  return loadAddressesFromRpc(client, limit);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? process.env.EXECUTION_RPC_URL_PRIMARY;
  if (rpcUrl === undefined || rpcUrl.trim() === "") {
    throw new Error("Set RPC_URL for Base mainnet");
  }
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) }) as unknown as PublicClient;
  const chainConfig = getChainConfig("base");
  const protocol = new ViemAaveV3Protocol(
    client,
    chainConfig,
    createGraphClient(resolveSubgraphUrl()),
    undefined,
    100,
  );
  const addresses = await loadAddresses(protocol, client, 500);
  console.log(`Loaded ${addresses.length} Base borrower addresses`);

  let recommended = 250;
  for (const batchSize of BATCH_SIZES) {
    const batchLatenciesMs: number[] = [];
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const startedAt = Date.now();
      await sweepHealthFactors(batch, {
        client,
        poolAddress: POOL,
        batchSize,
        minDebtBase: 0n,
      });
      batchLatenciesMs.push(Date.now() - startedAt);
    }
    const maxBatchMs = Math.max(...batchLatenciesMs);
    const totalMs = batchLatenciesMs.reduce((sum, value) => sum + value, 0);
    const ok = maxBatchMs < TARGET_MS;
    console.log(JSON.stringify({
      batchSize,
      batches: batchLatenciesMs.length,
      maxBatchMs,
      totalMs,
      targetMs: TARGET_MS,
      pass: ok,
      addresses: addresses.length,
    }));
    if (batchSize === 500 && !ok) {
      recommended = 250;
      break;
    }
    if (ok) {
      recommended = batchSize;
      break;
    }
    if (batchSize === 250) {
      recommended = 250;
    }
  }

  console.log(`RECOMMENDED_MULTICALL_BATCH_SIZE=${recommended}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
