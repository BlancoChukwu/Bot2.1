/**
 * Phase 0 pre-soak gate: live bootstrap coverage + shadow eMode segmentation smoke test.
 * Usage: DOTENV_CONFIG_PATH=.env.simulation npx ts-node scripts/verify-pre-soak-phase0.ts
 */
import "dotenv/config";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import { parseEventPurityConfig, hfThresholdToWad } from "../src/config/eventPurityConfig";
import { LocalPositionModel } from "../src/monitors/localPositionModel";
import { createSubgraphBorrowerDiscovery } from "../src/protocols/subgraphBorrowerDiscovery";
import { runPartialBootstrapSweep, type PartialBootstrapCoverage } from "../src/monitors/partialBootstrapSweep";
import { poolEmodeAbi } from "../src/monitors/aaveEmode";
import { ShadowValidator } from "../src/monitors/shadowValidator";

const logger = {
  info: (event: string, fields?: Record<string, unknown>) => {
    console.log(JSON.stringify({ event, ...fields }));
  },
  warn: (event: string, fields?: Record<string, unknown>) => {
    console.warn(JSON.stringify({ event, level: "warn", ...fields }));
  },
  error: (event: string, fields?: Record<string, unknown>) => {
    console.error(JSON.stringify({ event, level: "error", ...fields }));
  },
};

function resolveExecutionRpc(): string {
  const primary = process.env.EXECUTION_RPC_URL_PRIMARY?.trim();
  const fallback = process.env.EXECUTION_RPC_URL_FALLBACKS?.split(",")[0]?.trim();
  const rpcUrl = process.env.RPC_URL?.trim();
  const url = rpcUrl ?? fallback ?? primary;
  if (url === undefined || url.length === 0) {
    throw new Error("Set RPC_URL, EXECUTION_RPC_URL_FALLBACKS, or EXECUTION_RPC_URL_PRIMARY");
  }
  return url;
}

function resolveSubgraphUrl(): string | undefined {
  const explicit = process.env.AAVE_SUBGRAPH_URL?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const baseOnly = process.env.BASE_AAVE_SUBGRAPH_URL?.trim();
  if (baseOnly !== undefined && baseOnly.length > 0) {
    return baseOnly;
  }
  return undefined;
}

async function seedMinimalShadowProbeAccounts(input: {
  readonly client: PublicClient;
  readonly model: LocalPositionModel;
  readonly poolAddress: Address;
  readonly poolAddressesProvider: Address;
  readonly uiPoolDataProvider: Address;
  readonly subgraphUrl: string | undefined;
}): Promise<void> {
  if (input.subgraphUrl === undefined) {
    throw new Error("Subgraph URL required for shadow-only probe seeding");
  }
  const accounts = (await createSubgraphBorrowerDiscovery({
    protocol: "aave-v3",
    subgraphUrl: input.subgraphUrl,
  }).listBorrowerAddresses("base")).slice(0, 500);
  await runPartialBootstrapSweep({
    chain: "base",
    client: input.client,
    model: input.model,
    logger,
    lookbackDays: 1,
    poolAddress: input.poolAddress,
    skipLogDiscovery: true,
    discoveredAccounts: accounts,
    forcedDiscoverySource: "subgraph",
  });
}

async function runBootstrapForVerification(input: {
  readonly chain: "base";
  readonly client: PublicClient;
  readonly model: LocalPositionModel;
  readonly purityLookbackDays: number;
  readonly poolAddress: Address;
  readonly subgraphUrl: string | undefined;
  readonly forceSubgraph: boolean;
}): Promise<PartialBootstrapCoverage> {
  if (input.forceSubgraph) {
    if (input.subgraphUrl === undefined) {
      throw new Error("VERIFY_BOOTSTRAP_USE_SUBGRAPH requires subgraph URL in env");
    }
    logger.info("verify_phase0_bootstrap_forced_subgraph", {});
    const accounts = await createSubgraphBorrowerDiscovery({
      protocol: "aave-v3",
      subgraphUrl: input.subgraphUrl,
    }).listBorrowerAddresses(input.chain);
    return runPartialBootstrapSweep({
      chain: input.chain,
      client: input.client,
      model: input.model,
      logger,
      lookbackDays: input.purityLookbackDays,
      poolAddress: input.poolAddress,
      skipLogDiscovery: true,
      discoveredAccounts: accounts,
      forcedDiscoverySource: "subgraph",
    });
  }

  return runPartialBootstrapSweep({
    chain: input.chain,
    client: input.client,
    model: input.model,
    logger,
    lookbackDays: input.purityLookbackDays,
    poolAddress: input.poolAddress,
    chunkBlocks: BigInt(process.env.BOOTSTRAP_CHUNK_BLOCKS ?? "2000"),
    ...(input.subgraphUrl === undefined ? {} : { subgraphUrl: input.subgraphUrl }),
  });
}

async function pickShadowSampleAccounts(
  client: PublicClient,
  poolAddress: Address,
  model: LocalPositionModel,
): Promise<{ nonEMode: Address[]; eMode: Address[] }> {
  const nonEMode: Address[] = [];
  const eMode: Address[] = [];
  for (const position of model.positions.values()) {
    if (position.eModeCategoryId > 0) {
      if (eMode.length < 3) {
        eMode.push(position.account);
      }
    } else if (nonEMode.length < 3) {
      nonEMode.push(position.account);
    }
    if (nonEMode.length >= 3 && eMode.length >= 3) {
      break;
    }
  }

  if (eMode.length < 2) {
    for (const position of model.positions.values()) {
      if (eMode.length >= 3) {
        break;
      }
      if (eMode.some((a) => a.toLowerCase() === position.account.toLowerCase())) {
        continue;
      }
      const category = await client.readContract({
        address: poolAddress,
        abi: poolEmodeAbi,
        functionName: "getUserEMode",
        args: [position.account],
      }).catch(() => 0n);
      if (Number(category) > 0) {
        eMode.push(position.account);
        position.eModeCategoryId = Number(category);
      }
    }
  }

  return { nonEMode, eMode };
}

async function main(): Promise<void> {
  const chain = "base";
  const chainConfig = getChainConfig(chain);
  const purity = parseEventPurityConfig(process.env);
  const rpcUrl = resolveExecutionRpc();
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) }) as unknown as PublicClient;

  const model = new LocalPositionModel({
    purity,
    urgentHfWad: hfThresholdToWad(purity.localHfUrgent),
    watchHfWad: hfThresholdToWad(purity.localHfWatch),
  });

  logger.info("verify_phase0_start", {
    rpcHost: new URL(rpcUrl).hostname,
    bootstrapLookbackDays: purity.bootstrapLookbackDays,
    bootstrapEnabled: purity.bootstrapEnabled,
  });

  let coverage: PartialBootstrapCoverage | undefined;
  if (process.env.VERIFY_SHADOW_ONLY !== "true") {
    coverage = await runBootstrapForVerification({
      chain,
      client,
      model,
      purityLookbackDays: purity.bootstrapLookbackDays,
      poolAddress: chainConfig.aave.pool,
      subgraphUrl: resolveSubgraphUrl(),
      forceSubgraph: process.env.VERIFY_BOOTSTRAP_USE_SUBGRAPH === "true",
    });
  } else {
    logger.info("verify_phase0_bootstrap_skipped", { reason: "VERIFY_SHADOW_ONLY=true" });
  }

  if (coverage !== undefined) {
    logger.info("verify_phase0_bootstrap_summary", {
    discoverySource: coverage.discoverySource,
    usersSeeded: coverage.usersSeeded,
    usersWithDebt: coverage.usersWithDebt,
    uniqueUsersFromLogs: coverage.uniqueUsersFromLogs,
    estimatedDebtorCoveragePct: coverage.estimatedDebtorCoveragePct,
    seedErrors: coverage.seedErrors,
    positionCacheSize: coverage.positionCacheSize,
    blocksScanned: Number(coverage.blocksScanned),
    elapsedMs: coverage.elapsedMs,
    });
  }

  if (model.size() === 0) {
    await seedMinimalShadowProbeAccounts({
      client,
      model,
      poolAddress: chainConfig.aave.pool,
      poolAddressesProvider: chainConfig.aave.poolAddressesProvider,
      uiPoolDataProvider: chainConfig.aave.uiPoolDataProvider,
      subgraphUrl: resolveSubgraphUrl(),
    });
  }

  const shadow = new ShadowValidator({
    client,
    poolAddress: chainConfig.aave.pool,
    model,
    purity: { ...purity, shadowMaxSamplesPerDay: 10_000 },
    logger,
  });

  const head = await client.getBlockNumber();
  const { nonEMode, eMode } = await pickShadowSampleAccounts(client, chainConfig.aave.pool, model);

  for (const account of nonEMode) {
    const position = model.positions.get(account.toLowerCase());
    await shadow.sample(account, position?.cachedHfWad ?? 1_100_000_000_000_000_000n, head);
  }
  for (const account of eMode) {
    const position = model.positions.get(account.toLowerCase());
    await shadow.sample(account, position?.cachedHfWad ?? 1_100_000_000_000_000_000n, head);
  }

  shadow.logMetricsSnapshot("verify_phase0");
  const snapshot = shadow.getMetricsSnapshot();

  logger.info("verify_phase0_shadow_summary", {
    nonEModeSamples: snapshot.nonEMode.sampleCount,
    eModeSamples: snapshot.eMode.sampleCount,
    shadow_drift_non_eMode_bps: snapshot.shadowDriftNonEModeBps,
    shadow_drift_eMode_bps: snapshot.shadowDriftEModeBps,
    shadow_fn_rate_non_eMode_pct: snapshot.shadowFnRateNonEModePct,
    shadow_fn_rate_eMode_pct: snapshot.shadowFnRateEModePct,
    nonEModePicked: nonEMode.length,
    eModePicked: eMode.length,
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "verify_phase0_failed", error: String(error) }));
  process.exit(1);
});
