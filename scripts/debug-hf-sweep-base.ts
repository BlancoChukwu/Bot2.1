/**
 * P0 HF / debt gate diagnostic for Base Aave V3.
 * Usage: npx ts-node scripts/debug-hf-sweep-base.ts [--min-debt-base 100000000]
 */
import "dotenv/config";
import { createPublicClient, http, parseAbiItem, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { getChainConfig } from "../src/config/chains";
import { evaluateDustFilter } from "../src/protocols/liquidationCandidateFilter";

const WAD = 1_000_000_000_000_000_000n;
const POOL = getChainConfig("base").aave.pool;
const LIQUIDATION_CALL = parseAbiItem(
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
);
const ACCOUNT_DATA_ABI = parseAbiItem(
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
);

interface AccountSnapshot {
  readonly address: Address;
  readonly healthFactor: bigint;
  readonly totalDebtBase: bigint;
  readonly source: "liquidation_event" | "watchlist_sample";
}

interface FilterVerdict {
  readonly passesHf: boolean;
  readonly passesMinDebt: boolean;
  readonly passesRevenueGate: boolean;
  readonly debtUsd: number;
  readonly dustReason?: string;
}

function parseMinDebtBaseArg(): bigint {
  const idx = process.argv.indexOf("--min-debt-base");
  if (idx >= 0 && process.argv[idx + 1] !== undefined) {
    return BigInt(process.argv[idx + 1]!);
  }
  return 100_000_000n;
}

function resolveEnvMinDebtUsd(): number {
  const raw = process.env.MIN_LIQUIDATION_DEBT_USD?.trim();
  if (raw !== undefined && raw.length > 0) {
    return Number(raw);
  }
  const minProfit = Number(process.env.MIN_PROFIT_USD ?? "10");
  return Math.max(minProfit, 50);
}

function envMinDebtBase(): bigint {
  return BigInt(Math.trunc(resolveEnvMinDebtUsd() * 1e8));
}

function debtBaseToUsd(debtBase: bigint): number {
  return Number(debtBase) / 1e8;
}

function evaluateLayers(
  snapshot: AccountSnapshot,
  minDebtBase: bigint,
  minDebtUsd: number,
  gasCostUsd: number,
): FilterVerdict {
  const debtUsd = debtBaseToUsd(snapshot.totalDebtBase);
  const dust = evaluateDustFilter({ debtUsd, minDebtUsd, gasCostUsd });
  return {
    passesHf: snapshot.healthFactor < WAD,
    passesMinDebt: snapshot.totalDebtBase > minDebtBase,
    passesRevenueGate: !dust.isDust,
    debtUsd,
    ...(dust.reason === undefined ? {} : { dustReason: dust.reason }),
  };
}

async function fetchRecentLiquidationUsers(
  client: PublicClient,
  limit: number,
): Promise<Address[]> {
  const users: Address[] = [];
  const seen = new Set<string>();
  let head = await client.getBlockNumber();
  const chunk = 25_000n;
  const maxLookback = 2_000_000n;
  let scanned = 0n;

  while (users.length < limit && scanned < maxLookback && head > 0n) {
    const from = head > chunk ? head - chunk : 0n;
    const logs = await client.getLogs({
      address: POOL,
      event: LIQUIDATION_CALL,
      fromBlock: from,
      toBlock: head,
    });
    for (let i = logs.length - 1; i >= 0 && users.length < limit; i -= 1) {
      const log = logs[i]!;
      const user = (log as { args?: { user?: Address } }).args?.user;
      if (user === undefined) {
        continue;
      }
      const key = user.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      users.push(user);
    }
    scanned += head - from + 1n;
    head = from > 0n ? from - 1n : 0n;
  }

  return users;
}

async function readAccount(
  client: PublicClient,
  address: Address,
  source: AccountSnapshot["source"],
): Promise<AccountSnapshot | undefined> {
  try {
    const data = await client.readContract({
      address: POOL,
      abi: [ACCOUNT_DATA_ABI],
      functionName: "getUserAccountData",
      args: [address],
    });
    return {
      address,
      healthFactor: data[5],
      totalDebtBase: data[1],
      source,
    };
  } catch {
    return undefined;
  }
}

function printVerdict(
  snapshot: AccountSnapshot,
  probeMinDebtBase: bigint,
  envDebtBase: bigint,
  minDebtUsd: number,
  gasCostUsd: number,
): { readonly probeLiquidatable: boolean; readonly envLiquidatable: boolean } {
  const probe = evaluateLayers(snapshot, probeMinDebtBase, minDebtUsd, gasCostUsd);
  const env = evaluateLayers(snapshot, envDebtBase, minDebtUsd, gasCostUsd);
  const hfStr = (Number(snapshot.healthFactor) / 1e18).toFixed(4);
  console.log(JSON.stringify({
    address: snapshot.address,
    source: snapshot.source,
    healthFactor: hfStr,
    debtUsd: probe.debtUsd.toFixed(2),
    probeMinDebtUsd: (Number(probeMinDebtBase) / 1e8).toFixed(2),
    envMinDebtUsd: resolveEnvMinDebtUsd(),
    layers: {
      hfBelow1: probe.passesHf,
      passesProbeMinDebt: probe.passesMinDebt,
      passesEnvMinDebt: env.passesMinDebt,
      passesRevenueGate: env.passesRevenueGate,
      dustReason: env.dustReason ?? null,
    },
    probeLiquidatable: probe.passesHf && probe.passesMinDebt,
    envLiquidatable: env.passesHf && env.passesMinDebt && env.passesRevenueGate,
  }));
  return {
    probeLiquidatable: probe.passesHf && probe.passesMinDebt,
    envLiquidatable: env.passesHf && env.passesMinDebt && env.passesRevenueGate,
  };
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? process.env.EXECUTION_RPC_URL_PRIMARY;
  if (rpcUrl === undefined || rpcUrl.trim() === "") {
    throw new Error("Set RPC_URL or EXECUTION_RPC_URL_PRIMARY");
  }

  const probeMinDebtBase = parseMinDebtBaseArg();
  const envDebtBase = envMinDebtBase();
  const minDebtUsd = resolveEnvMinDebtUsd();
  const gasCostUsd = Number(process.env.GAS_COST_USD ?? "0.0005");

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) }) as unknown as PublicClient;
  console.log(JSON.stringify({
    msg: "debug_hf_sweep_start",
    pool: POOL,
    probeMinDebtBase: probeMinDebtBase.toString(),
    probeMinDebtUsd: Number(probeMinDebtBase) / 1e8,
    envMinDebtUsd: minDebtUsd,
    envMinDebtBase: envDebtBase.toString(),
    gasCostUsd,
  }));

  const liquidationUsers = await fetchRecentLiquidationUsers(client, 100);
  console.log(JSON.stringify({
    msg: "liquidation_call_addresses",
    count: liquidationUsers.length,
  }));

  let stillUnhealthy = 0;
  let probeHits = 0;
  let envHits = 0;
  let blockedByEnvDebtOnly = 0;

  for (const user of liquidationUsers) {
    const snapshot = await readAccount(client, user, "liquidation_event");
    if (snapshot === undefined) {
      continue;
    }
    if (snapshot.healthFactor < WAD && snapshot.totalDebtBase > 0n) {
      stillUnhealthy += 1;
      console.log(JSON.stringify({
        msg: "still_unhealthy_after_liquidation",
        address: snapshot.address,
        healthFactor: (Number(snapshot.healthFactor) / 1e18).toString(),
        debtUsd: debtBaseToUsd(snapshot.totalDebtBase).toFixed(2),
      }));
    }
    const verdict = printVerdict(snapshot, probeMinDebtBase, envDebtBase, minDebtUsd, gasCostUsd);
    if (verdict.probeLiquidatable) {
      probeHits += 1;
    }
    if (verdict.envLiquidatable) {
      envHits += 1;
    }
    if (verdict.probeLiquidatable && !verdict.envLiquidatable) {
      blockedByEnvDebtOnly += 1;
    }
  }

  const summary = {
    msg: "debug_hf_sweep_summary",
    liquidationEventsSampled: liquidationUsers.length,
    stillUnhealthyAfterLiquidation: stillUnhealthy,
    probeLiquidatableCount: probeHits,
    envLiquidatableCount: envHits,
    blockedByEnvMinDebtOnly: blockedByEnvDebtOnly,
    verdict:
      probeHits > 0 && envHits === 0 && blockedByEnvDebtOnly > 0
        ? "MIN_DEBT_GATE_LIKELY_CULPRIT"
        : probeHits === 0 && stillUnhealthy === 0
          ? "MARKET_CALM_OR_ADDRESSES_HEALTHY_NOW"
          : probeHits > 0
            ? "LIQUIDATABLE_EXISTS_CHECK_PIPELINE"
            : "INVESTIGATE_SEED_COVERAGE_OR_HF",
  };
  console.log(JSON.stringify(summary));

  if (probeHits > 0 && envHits === 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
