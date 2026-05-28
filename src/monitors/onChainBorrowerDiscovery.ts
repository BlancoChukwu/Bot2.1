import type { Address, PublicClient } from "viem";
import { aavePoolAbi } from "../protocols/aaveV3";
import {
  extractBorrowerAddressesFromLog,
  poolAddressForChain,
} from "./borrowerLogExtract";

const borrowEvent = aavePoolAbi.find((item) => item.type === "event" && item.name === "Borrow");
import type { SupportedChain } from "../config/chains";

const liquidationEvent = aavePoolAbi.find((item) => item.type === "event" && item.name === "LiquidationCall");

export interface OnChainBorrowerDiscoveryConfig {
  readonly chain: SupportedChain;
  readonly poolAddress?: Address;
  readonly client: PublicClient;
  readonly lookbackBlocks: bigint;
  readonly chunkBlocks?: bigint;
  readonly maxBlocks?: bigint;
}

export interface OnChainBorrowerDiscoveryResult {
  readonly accounts: readonly Address[];
  readonly blocksScanned: bigint;
  readonly elapsedMs: number;
  readonly borrowLogs: number;
}

/**
 * Discovers active borrowers from pool Borrow (+ LiquidationCall) logs (no subgraph).
 * Uses archive-capable HTTP RPC (not Flashblocks pending-only endpoints).
 */
export async function discoverBorrowersFromLogs(
  config: OnChainBorrowerDiscoveryConfig,
): Promise<OnChainBorrowerDiscoveryResult> {
  const startedAt = Date.now();
  const poolAddress = config.poolAddress ?? poolAddressForChain(config.chain);
  const head = await config.client.getBlockNumber();
  const lookback = config.lookbackBlocks;
  const maxBlocks = config.maxBlocks ?? lookback;
  const blocksToScan = lookback > maxBlocks ? maxBlocks : lookback;
  const from = head > blocksToScan ? head - blocksToScan : 0n;
  const chunk = config.chunkBlocks ?? 5_000n;
  const accounts = new Set<Address>();
  let borrowLogs = 0;

  for (let start = from; start <= head; start += chunk) {
    const end = start + chunk - 1n > head ? head : start + chunk - 1n;
    if (borrowEvent === undefined) {
      throw new Error("Aave Borrow event missing from ABI");
    }
    const logs = await config.client.getLogs({
      address: poolAddress,
      event: borrowEvent,
      fromBlock: start,
      toBlock: end,
    });
    borrowLogs += logs.length;
    for (const log of logs) {
      for (const address of extractBorrowerAddressesFromLog(log)) {
        accounts.add(address);
      }
    }
    if (liquidationEvent !== undefined) {
      const liqLogs = await config.client.getLogs({
        address: poolAddress,
        event: liquidationEvent,
        fromBlock: start,
        toBlock: end,
      });
      for (const log of liqLogs) {
        const args = (log as { args?: { user?: Address } }).args;
        if (args?.user !== undefined) {
          accounts.add(args.user);
        }
      }
    }
  }

  return {
    accounts: [...accounts],
    blocksScanned: head - from,
    elapsedMs: Date.now() - startedAt,
    borrowLogs,
  };
}

export async function filterAccountsWithDebt(
  client: PublicClient,
  poolAddress: Address,
  accounts: readonly Address[],
  batchSize = 250,
): Promise<readonly Address[]> {
  const withDebt: Address[] = [];
  for (let i = 0; i < accounts.length; i += batchSize) {
    const batch = accounts.slice(i, i + batchSize);
    const results = await client.multicall({
      contracts: batch.map((address) => ({
        address: poolAddress,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [address],
      })),
    });
    for (let j = 0; j < batch.length; j += 1) {
      const row = results[j];
      if (row === undefined || row.status !== "success") {
        continue;
      }
      const accountData = row.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      const totalDebtBase = accountData[1];
      if (totalDebtBase > 0n) {
        withDebt.push(batch[j]!);
      }
    }
  }
  return withDebt;
}
