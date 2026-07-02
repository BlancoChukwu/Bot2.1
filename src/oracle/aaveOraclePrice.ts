import type { Address, PublicClient } from "viem";
import type { LoggerLike } from "../bot";
import type { LocalPositionModel } from "../monitors/localPositionModel";
import { canonicalBaseAaveOracleAddress } from "../utils/priceOracleCache";
import {
  BASE_AAVE_ORACLE,
  BASE_GAP_FILL_ASSETS,
  BASE_USDC,
} from "./baseReserveAssets";
import {
  isPegDivergenceAcceptable,
  isUsdbcAsset,
  pegDivergenceBps,
  pegUsdbcFromUsdcPrice,
} from "./pegPriceNormalizer";
import {
  pegUsdbcPriceFromHealthyReference,
  type PegReferenceHealthInput,
} from "./healthyPegAsset";
import { collectAssetsNeedingGapFill, computeOracleCoverage } from "./oracleCoverage";

const AAVE_PRICE_DECIMALS = 8;
const WAD = 1_000_000_000_000_000_000n;
const MULTICALL_BATCH_SIZE = 250;

const aaveOracleAbi = [
  {
    name: "getAssetPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export function normalizeAavePriceToWad18(priceBase8: bigint): bigint {
  if (priceBase8 <= 0n) {
    return 0n;
  }
  return priceBase8 * 10n ** 10n;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function fetchAaveAssetPrices(
  client: PublicClient,
  oracle: Address,
  assets: readonly Address[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (const batch of chunkArray(assets, MULTICALL_BATCH_SIZE)) {
    const results = await client.multicall({
      contracts: batch.map((asset) => ({
        address: oracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [asset],
      })),
      allowFailure: true,
    });
    for (let i = 0; i < batch.length; i += 1) {
      const asset = batch[i]!;
      const response = results[i];
      if (response?.status !== "success") {
        continue;
      }
      const price = response.result;
      if (typeof price === "bigint" && price > 0n) {
        out.set(asset.toLowerCase(), price);
      }
    }
  }
  return out;
}

function registerAavePrice(
  model: LocalPositionModel,
  asset: Address,
  priceBase8: bigint,
  oracle: Address,
  logger: LoggerLike,
  nowSec: number,
): void {
  const normalized = normalizeAavePriceToWad18(priceBase8);
  if (normalized === 0n) {
    return;
  }
  model.registerBootstrapPrice(asset, normalized, {
    answer: priceBase8,
    decimals: AAVE_PRICE_DECIMALS,
    updatedAt: nowSec,
    feedAddress: oracle,
    asset,
    source: "aave",
  });
  logger.info("oracle_price_registered", {
    asset,
    source: "aave",
    priceWad18: normalized.toString(),
    priceBase8: priceBase8.toString(),
  });
}

function registerPegPrice(
  model: LocalPositionModel,
  asset: Address,
  pegPriceWad18: bigint,
  pegOf: Address,
  logger: LoggerLike,
  nowSec: number,
): void {
  model.registerBootstrapPrice(asset, pegPriceWad18, {
    answer: pegPriceWad18 / 10n ** 10n,
    decimals: AAVE_PRICE_DECIMALS,
    updatedAt: nowSec,
    feedAddress: pegOf,
    asset,
    source: "peg",
  });
  logger.info("oracle_price_registered", {
    asset,
    source: "peg",
    pegOf,
    priceWad18: pegPriceWad18.toString(),
  });
}

export async function bootstrapAaveOracleGapFill(input: {
  readonly client: PublicClient;
  readonly model: LocalPositionModel;
  readonly logger: LoggerLike;
  readonly oracle?: Address;
  readonly nowSec?: number;
}): Promise<{ warmed: number; failed: readonly Address[] }> {
  const oracle = input.oracle ?? BASE_AAVE_ORACLE;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const needed = collectAssetsNeedingGapFill(input.model);
  if (needed.length === 0) {
    logOracleBootstrapCoverage(input.model, input.logger);
    return { warmed: 0, failed: [] };
  }

  input.logger.info("oracle_gap_fill_start", {
    targetCount: needed.length,
    knownGapFillAssets: BASE_GAP_FILL_ASSETS.length,
    targets: needed.slice(0, 20),
  });

  for (const asset of needed) {
    input.model.registerReserve(asset);
  }

  const aaveAssets = needed.filter((asset) => !isUsdbcAsset(asset));
  const aavePrices = await fetchAaveAssetPrices(input.client, oracle, aaveAssets);

  let warmed = 0;
  const failed: Address[] = [];

  for (const asset of aaveAssets) {
    const price = aavePrices.get(asset.toLowerCase());
    if (price === undefined) {
      failed.push(asset);
      continue;
    }
    registerAavePrice(input.model, asset, price, oracle, input.logger, nowSec);
    warmed += 1;
  }

  for (const asset of needed.filter(isUsdbcAsset)) {
    const healthInput: PegReferenceHealthInput = {
      prices: input.model.prices,
      feedStates: input.model.feedStates,
      nowSec,
    };
    const healthyPegPrice = pegUsdbcPriceFromHealthyReference(healthInput);
    if (healthyPegPrice !== undefined) {
      registerPegPrice(input.model, asset, healthyPegPrice, BASE_USDC, input.logger, nowSec);
      warmed += 1;
      continue;
    }
    const usdcPrice = input.model.prices.get(BASE_USDC.toLowerCase());
    if (usdcPrice === undefined || usdcPrice <= 1n) {
      failed.push(asset);
      continue;
    }
    const pegPrice = pegUsdbcFromUsdcPrice(usdcPrice);
    const aaveUsdbc = (await fetchAaveAssetPrices(input.client, oracle, [asset])).get(asset.toLowerCase());
    if (aaveUsdbc !== undefined && !isPegDivergenceAcceptable(pegPrice, aaveUsdbc)) {
      input.logger.warn("oracle_peg_divergence_warn", {
        asset,
        pegDivergenceBps: pegDivergenceBps(pegPrice, aaveUsdbc),
        pegPriceWad18: pegPrice.toString(),
        aavePriceBase8: aaveUsdbc.toString(),
      });
    }
    registerPegPrice(input.model, asset, pegPrice, BASE_USDC, input.logger, nowSec);
    warmed += 1;
  }

  logOracleBootstrapCoverage(input.model, input.logger);
  input.logger.info("oracle_gap_fill_complete", {
    warmed,
    failedCount: failed.length,
    failed: failed.slice(0, 20),
  });
  return { warmed, failed };
}

export function logOracleBootstrapCoverage(model: LocalPositionModel, logger: LoggerLike): void {
  const coverage = computeOracleCoverage(model);
  logger.info("oracle_bootstrap_coverage", {
    covered_pct: coverage.coveredPct,
    covered_assets: coverage.coveredAssets,
    total_position_assets: coverage.totalPositionAssets,
    blind_assets: coverage.blindAssets,
    blind_positions: coverage.blindPositionCount,
    blind_asset_addresses: coverage.blindAssetAddresses,
  });
}

export async function refreshAaveOraclePrices(input: {
  readonly client: PublicClient;
  readonly model: LocalPositionModel;
  readonly logger: LoggerLike;
  readonly oracle?: Address;
}): Promise<void> {
  await bootstrapAaveOracleGapFill(input);
}

export { canonicalBaseAaveOracleAddress as defaultAaveOracleAddress };
