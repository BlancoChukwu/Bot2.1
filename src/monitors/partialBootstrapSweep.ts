import type { Address, AbiEvent, Log, PublicClient } from "viem";
import { getChainConfig, type SupportedChain } from "../config/chains";
import { reservesTouchAllowlist } from "../config/watchlistReserveFilter";
import { aavePoolAbi } from "../protocols/aaveV3";
import { uiPoolDataProviderAbi } from "../protocols/uiPoolDataProvider";
import type { LoggerLike } from "../bot";
import type { LocalPositionModel } from "./localPositionModel";
import {
  extractBorrowerAddressesFromLog,
  extractUserAddressesFromAavePoolLog,
  poolAddressForChain,
} from "./borrowerLogExtract";
import { filterAccountsWithDebt } from "./onChainBorrowerDiscovery";
import { createSubgraphBorrowerDiscovery } from "../protocols/subgraphBorrowerDiscovery";
import type { BootstrapRpcEndpoint } from "./bootstrapRpcClients";
import { isRetryableRpcError } from "./bootstrapRpcClients";
import type { BootstrapDiscoverySource } from "./bootstrapTypes";
import { BootstrapSnapshotStore, buildSnapshotFromModel } from "./bootstrapSnapshotStore";
import {
  addressesFromDiscoveryCache,
  BootstrapDiscoveryCacheStore,
  DISCOVERY_CACHE_VERSION,
  shouldForceBootstrapDiscoveryRefresh,
} from "./bootstrapDiscoveryCache";
import {
  seedModelFromAccountSnapshot,
} from "./positionOnChainReconcile";

export type { BootstrapDiscoverySource } from "./bootstrapTypes";

const BASE_BLOCKS_PER_DAY = 43_200n;
const BOOTSTRAP_EVENT_NAMES = ["Supply", "Borrow", "Repay", "Withdraw", "LiquidationCall"] as const;
const GETLOGS_ATTEMPTS_PER_RPC = 3;

export interface PartialBootstrapConfig {
  readonly chain: SupportedChain;
  readonly client: PublicClient;
  readonly model: LocalPositionModel;
  readonly logger: LoggerLike;
  readonly lookbackDays: number;
  readonly chunkBlocks?: bigint;
  readonly accountBatchSize?: number;
  readonly reserveDataBatchSize?: number;
  readonly poolAddress?: Address;
  readonly subgraphUrl?: string;
  readonly skipLogDiscovery?: boolean;
  readonly discoveredAccounts?: readonly Address[];
  readonly forcedDiscoverySource?: BootstrapDiscoverySource;
  readonly logDiscoveryClients?: readonly BootstrapRpcEndpoint[];
  readonly cacheEnabled?: boolean;
  readonly cacheTtlHours?: number;
  readonly reserveAllowlist?: readonly Address[];
}

export interface PartialBootstrapCoverage {
  readonly discoverySource: BootstrapDiscoverySource;
  readonly uniqueUsersFromLogs: number;
  readonly borrowLogUniqueUsers: number;
  readonly usersWithDebt: number;
  readonly usersSeeded: number;
  readonly seedErrors: number;
  readonly accountsAllowlistMatched: number;
  readonly blocksScanned: bigint;
  readonly lookbackDays: number;
  readonly elapsedMs: number;
  readonly positionCacheSize: number;
  readonly estimatedDebtorCoveragePct: number;
  readonly cacheHit: boolean;
  readonly discoveryCacheHit: boolean;
}

interface LogDiscoveryResult {
  readonly accounts: readonly Address[];
  readonly borrowAccounts: readonly Address[];
  readonly blocksScanned: bigint;
  readonly totalLogs: number;
}

export async function runPartialBootstrapSweep(
  config: PartialBootstrapConfig,
): Promise<PartialBootstrapCoverage> {
  const startedAt = Date.now();
  const chainConfig = getChainConfig(config.chain);
  const poolAddress = config.poolAddress ?? poolAddressForChain(config.chain);
  const head = await config.client.getBlockNumber();
  const lookbackBlocks = BigInt(config.lookbackDays) * BASE_BLOCKS_PER_DAY;
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  const snapshotStore = new BootstrapSnapshotStore({
    chain: config.chain,
    ttlHours: config.cacheTtlHours ?? 24,
    logger: config.logger,
  });

  if (config.cacheEnabled !== false) {
    const cached = await snapshotStore.loadIfFresh();
    if (cached !== undefined) {
      const usersSeeded = snapshotStore.applyToModel(config.model, cached);
      const coverage = buildCoverage({
        discoverySource: "cache",
        discovery: {
          accounts: cached.positions.map((row) => row.account),
          borrowAccounts: [],
          blocksScanned: head - from,
          totalLogs: 0,
        },
        withDebtCount: usersSeeded,
        usersSeeded,
        seedErrors: 0,
        accountsAllowlistMatched: usersSeeded,
        lookbackDays: config.lookbackDays,
        startedAt,
        model: config.model,
        cacheHit: true,
        discoveryCacheHit: false,
      });
      logCoverage(config, coverage, poolAddress, from, head, 0);
      return coverage;
    }
  }

  let discovery: LogDiscoveryResult;
  let discoverySource: BootstrapDiscoverySource = config.forcedDiscoverySource ?? "logs";
  let withDebt: readonly Address[];
  let discoveryCacheHit = false;

  const discoveryCacheStore = new BootstrapDiscoveryCacheStore({
    chain: config.chain,
    ttlHours: config.cacheTtlHours ?? 24,
    logger: config.logger,
  });
  const forceRefresh = shouldForceBootstrapDiscoveryRefresh();

  if (!forceRefresh) {
    const cachedDiscovery = await discoveryCacheStore.loadIfFresh(head);
    if (cachedDiscovery !== undefined) {
      discoveryCacheHit = true;
      discoverySource = cachedDiscovery.discoverySource;
      const loaded = addressesFromDiscoveryCache(cachedDiscovery);
      discovery = {
        accounts: loaded.accounts,
        borrowAccounts: [],
        blocksScanned: head - from,
        totalLogs: 0,
      };
      withDebt = loaded.withDebt;
      config.logger.info("discovery_cache_hit", {
        chain: config.chain,
        accountsDiscovered: discovery.accounts.length,
        accountsWithDebt: withDebt.length,
      });
    } else {
      config.logger.info("discovery_cache_miss", { chain: config.chain });
      ({ discovery, discoverySource, withDebt } = await discoverAccountsWithDebt(config, {
        poolAddress,
        from,
        head,
      }));
      await discoveryCacheStore.save({
        version: DISCOVERY_CACHE_VERSION,
        chain: config.chain,
        savedAtMs: Date.now(),
        blockNumber: head.toString(),
        discoverySource,
        accounts: discovery.accounts.map((row) => row.toLowerCase()),
        withDebt: withDebt.map((row) => row.toLowerCase()),
      });
    }
  } else {
    config.logger.info("discovery_cache_force_refresh", { chain: config.chain });
    ({ discovery, discoverySource, withDebt } = await discoverAccountsWithDebt(config, {
      poolAddress,
      from,
      head,
    }));
    await discoveryCacheStore.save({
      version: DISCOVERY_CACHE_VERSION,
      chain: config.chain,
      savedAtMs: Date.now(),
      blockNumber: head.toString(),
      discoverySource,
      accounts: discovery.accounts.map((row) => row.toLowerCase()),
      withDebt: withDebt.map((row) => row.toLowerCase()),
    });
  }

  const seedResult = await seedModelFromOnChain({
    client: config.client,
    model: config.model,
    poolAddress,
    poolAddressesProvider: chainConfig.aave.poolAddressesProvider,
    uiPoolDataProvider: chainConfig.aave.uiPoolDataProvider,
    accounts: withDebt,
    blockNumber: head,
    batchSize: config.reserveDataBatchSize ?? 50,
    logger: config.logger,
    ...(config.reserveAllowlist === undefined ? {} : { reserveAllowlist: config.reserveAllowlist }),
  });

  const coverage = buildCoverage({
    discoverySource,
    discovery,
    withDebtCount: withDebt.length,
    usersSeeded: seedResult.seeded,
    seedErrors: seedResult.errors,
    accountsAllowlistMatched: seedResult.allowlistMatched,
    lookbackDays: config.lookbackDays,
    startedAt,
    model: config.model,
    cacheHit: false,
    discoveryCacheHit,
  });

  if (config.cacheEnabled !== false && seedResult.seeded > 0) {
    await snapshotStore.save(buildSnapshotFromModel(config.model, {
      chain: config.chain,
      discoverySource,
      blockNumber: head,
    }));
  }

  logCoverage(config, coverage, poolAddress, from, head, discovery.totalLogs);
  return coverage;
}

async function discoverAccountsWithDebt(
  config: PartialBootstrapConfig,
  input: { readonly poolAddress: Address; readonly from: bigint; readonly head: bigint },
): Promise<{
  readonly discovery: LogDiscoveryResult;
  readonly discoverySource: BootstrapDiscoverySource;
  readonly withDebt: readonly Address[];
}> {
  let discovery: LogDiscoveryResult;
  let discoverySource: BootstrapDiscoverySource = config.forcedDiscoverySource ?? "logs";
  if (config.skipLogDiscovery === true && config.discoveredAccounts !== undefined) {
    discovery = {
      accounts: config.discoveredAccounts,
      borrowAccounts: [],
      blocksScanned: input.head - input.from,
      totalLogs: 0,
    };
  } else {
    const logClients = config.logDiscoveryClients ?? [{ client: config.client, host: "primary" }];
    try {
      discovery = await discoverUsersFromPoolLogs({
        clients: logClients,
        poolAddress: input.poolAddress,
        fromBlock: input.from,
        toBlock: input.head,
        chunkBlocks: config.chunkBlocks ?? 2_000n,
        logger: config.logger,
      });
    } catch (error) {
      const subgraphUrl = config.subgraphUrl;
      if (subgraphUrl === undefined || subgraphUrl.trim() === "") {
        throw error;
      }
      config.logger.warn("partial_bootstrap_logs_failed_using_subgraph", {
        error: String(error),
      });
      discoverySource = "subgraph";
      const subgraphAccounts = await createSubgraphBorrowerDiscovery({
        protocol: "aave-v3",
        subgraphUrl,
      }).listBorrowerAddresses(config.chain);
      discovery = {
        accounts: subgraphAccounts,
        borrowAccounts: [],
        blocksScanned: input.head - input.from,
        totalLogs: 0,
      };
    }
  }

  const withDebt = await filterAccountsWithDebt(
    config.client,
    input.poolAddress,
    discovery.accounts,
    config.accountBatchSize ?? 250,
  );

  return { discovery, discoverySource, withDebt };
}

function buildCoverage(input: {
  readonly discoverySource: BootstrapDiscoverySource;
  readonly discovery: LogDiscoveryResult;
  readonly withDebtCount: number;
  readonly usersSeeded: number;
  readonly seedErrors: number;
  readonly accountsAllowlistMatched: number;
  readonly lookbackDays: number;
  readonly startedAt: number;
  readonly model: LocalPositionModel;
  readonly cacheHit: boolean;
  readonly discoveryCacheHit: boolean;
}): PartialBootstrapCoverage {
  return {
    discoverySource: input.discoverySource,
    uniqueUsersFromLogs: input.discovery.accounts.length,
    borrowLogUniqueUsers: input.discovery.borrowAccounts.length,
    usersWithDebt: input.withDebtCount,
    usersSeeded: input.usersSeeded,
    seedErrors: input.seedErrors,
    accountsAllowlistMatched: input.accountsAllowlistMatched,
    blocksScanned: input.discovery.blocksScanned,
    lookbackDays: input.lookbackDays,
    elapsedMs: Date.now() - input.startedAt,
    positionCacheSize: input.model.size(),
    estimatedDebtorCoveragePct: input.discovery.accounts.length === 0
      ? 0
      : (input.withDebtCount / input.discovery.accounts.length) * 100,
    cacheHit: input.cacheHit,
    discoveryCacheHit: input.discoveryCacheHit,
  };
}

function logCoverage(
  config: PartialBootstrapConfig,
  coverage: PartialBootstrapCoverage,
  poolAddress: Address,
  from: bigint,
  head: bigint,
  totalLogs: number,
): void {
  config.logger.info("partial_bootstrap_coverage", {
    discoverySource: coverage.discoverySource,
    bootstrapSource: coverage.discoverySource,
    cacheHit: coverage.cacheHit,
    discoveryCacheHit: coverage.discoveryCacheHit,
    accountsDiscovered: coverage.uniqueUsersFromLogs,
    accountsWithDebt: coverage.usersWithDebt,
    accountsAllowlistMatched: coverage.accountsAllowlistMatched,
    uniqueUsersFromLogs: coverage.uniqueUsersFromLogs,
    borrowLogUniqueUsers: coverage.borrowLogUniqueUsers,
    usersWithDebt: coverage.usersWithDebt,
    usersSeeded: coverage.usersSeeded,
    seedErrors: coverage.seedErrors,
    blocksScanned: Number(coverage.blocksScanned),
    lookbackDays: coverage.lookbackDays,
    elapsedMs: coverage.elapsedMs,
    positionCacheSize: coverage.positionCacheSize,
    estimatedDebtorCoveragePct: coverage.estimatedDebtorCoveragePct,
    totalLogs,
    poolAddress,
    fromBlock: Number(from),
    toBlock: Number(head),
  });
}

async function discoverUsersFromPoolLogs(input: {
  readonly clients: readonly BootstrapRpcEndpoint[];
  readonly poolAddress: Address;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly chunkBlocks: bigint;
  readonly logger: LoggerLike;
}): Promise<LogDiscoveryResult> {
  const accounts = new Set<string>();
  const borrowAccounts = new Set<string>();
  let totalLogs = 0;

  for (const eventName of BOOTSTRAP_EVENT_NAMES) {
    const found = aavePoolAbi.find((item) => item.type === "event" && item.name === eventName);
    if (found === undefined || found.type !== "event") {
      continue;
    }
    const event = found as AbiEvent;
    for (let start = input.fromBlock; start <= input.toBlock; start += input.chunkBlocks) {
      const end = start + input.chunkBlocks - 1n > input.toBlock ? input.toBlock : start + input.chunkBlocks - 1n;
      const logs = await getLogsWithRpcRotation({
        clients: input.clients,
        poolAddress: input.poolAddress,
        event,
        fromBlock: start,
        toBlock: end,
        logger: input.logger,
      });
      totalLogs += logs.length;
      for (const log of logs) {
        const addresses = eventName === "Borrow"
          ? extractBorrowerAddressesFromLog(log)
          : extractUserAddressesFromAavePoolLog(log);
        for (const address of addresses) {
          accounts.add(address.toLowerCase());
          if (eventName === "Borrow") {
            borrowAccounts.add(address.toLowerCase());
          }
        }
      }
    }
  }

  return {
    accounts: [...accounts].map((key) => key as Address),
    borrowAccounts: [...borrowAccounts].map((key) => key as Address),
    blocksScanned: input.toBlock - input.fromBlock,
    totalLogs,
  };
}

async function seedModelFromOnChain(input: {
  readonly client: PublicClient;
  readonly model: LocalPositionModel;
  readonly poolAddress: Address;
  readonly poolAddressesProvider: Address;
  readonly uiPoolDataProvider: Address;
  readonly accounts: readonly Address[];
  readonly blockNumber: bigint;
  readonly batchSize: number;
  readonly reserveAllowlist?: readonly Address[];
  readonly logger: LoggerLike;
}): Promise<{ readonly seeded: number; readonly errors: number; readonly allowlistMatched: number }> {
  let seeded = 0;
  let errors = 0;
  let allowlistMatched = 0;

  for (let i = 0; i < input.accounts.length; i += input.batchSize) {
    const batch = input.accounts.slice(i, i + input.batchSize);
    const accountResults = await input.client.multicall({
      contracts: batch.map((address) => ({
        address: input.poolAddress,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [address],
      })),
      allowFailure: true,
    });
    const reserveResults = await input.client.multicall({
      contracts: batch.map((address) => ({
        address: input.uiPoolDataProvider,
        abi: uiPoolDataProviderAbi,
        functionName: "getUserReservesData",
        args: [input.poolAddressesProvider, address],
      })),
      allowFailure: true,
    });

    for (let j = 0; j < batch.length; j += 1) {
      const address = batch[j]!;
      const accountRow = accountResults[j];
      const reserveRow = reserveResults[j];
      if (accountRow?.status !== "success") {
        errors += 1;
        continue;
      }
      const accountData = accountRow.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      const totalDebtBase = accountData[1];
      if (totalDebtBase === 0n) {
        continue;
      }

      const reserves: { asset: Address; scaledCollateral: bigint; scaledDebt: bigint }[] = [];
      let eModeCategoryId = 0;
      if (reserveRow?.status === "success") {
        const reserveData = reserveRow.result as unknown as readonly [
          readonly {
            readonly underlyingAsset: Address;
            readonly scaledATokenBalance: bigint;
            readonly usageAsCollateralEnabledOnUser: boolean;
            readonly stableBorrowRate: bigint;
            readonly scaledVariableDebt: bigint;
          }[],
          number,
        ];
        eModeCategoryId = Number(reserveData[1]);
        for (const row of reserveData[0]) {
          if (row.scaledATokenBalance === 0n && row.scaledVariableDebt === 0n) {
            continue;
          }
          reserves.push({
            asset: row.underlyingAsset,
            scaledCollateral: row.usageAsCollateralEnabledOnUser ? row.scaledATokenBalance : 0n,
            scaledDebt: row.scaledVariableDebt,
          });
          input.model.registerReserve(row.underlyingAsset);
        }
      }

      if (input.reserveAllowlist !== undefined
        && input.reserveAllowlist.length > 0
        && !reservesTouchAllowlist(reserves, input.reserveAllowlist)) {
        continue;
      }
      allowlistMatched += 1;

      try {
        seedModelFromAccountSnapshot(input.model, {
          account: address,
          eModeCategoryId,
          healthFactorWad: accountData[5],
          totalCollateralBase: accountData[0],
          totalDebtBase,
          liquidationThreshold: accountData[3],
          reserves,
        }, input.blockNumber);
        seeded += 1;
      } catch (error) {
        errors += 1;
        input.logger.warn("partial_bootstrap_seed_failed", {
          account: address,
          error: String(error),
        });
      }
    }
  }

  return { seeded, errors, allowlistMatched };
}

export function lookbackDaysToBlocks(days: number): bigint {
  return BigInt(days) * BASE_BLOCKS_PER_DAY;
}

async function getLogsWithRpcRotation(input: {
  readonly clients: readonly BootstrapRpcEndpoint[];
  readonly poolAddress: Address;
  readonly event: AbiEvent;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly logger: LoggerLike;
}): Promise<readonly Log[]> {
  if (input.clients.length === 0) {
    throw new Error("partial_bootstrap_no_rpc_clients");
  }

  let lastError: unknown;
  for (let clientIndex = 0; clientIndex < input.clients.length; clientIndex += 1) {
    const endpoint = input.clients[clientIndex]!;
    for (let attempt = 1; attempt <= GETLOGS_ATTEMPTS_PER_RPC; attempt += 1) {
      try {
        return await endpoint.client.getLogs({
          address: input.poolAddress,
          event: input.event,
          fromBlock: input.fromBlock,
          toBlock: input.toBlock,
        });
      } catch (error) {
        lastError = error;
        if (!isRetryableRpcError(error)) {
          throw error;
        }
        const delayMs = attempt * 2_000;
        input.logger.warn("partial_bootstrap_getlogs_retry", {
          rpcHost: endpoint.host,
          attempt,
          delayMs,
          fromBlock: Number(input.fromBlock),
          toBlock: Number(input.toBlock),
        });
        if (attempt < GETLOGS_ATTEMPTS_PER_RPC) {
          await sleep(delayMs);
        }
      }
    }
    const next = input.clients[clientIndex + 1];
    if (next !== undefined) {
      input.logger.warn("partial_bootstrap_rpc_rotate", {
        fromHost: endpoint.host,
        toHost: next.host,
        fromBlock: Number(input.fromBlock),
        toBlock: Number(input.toBlock),
      });
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
