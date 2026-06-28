import type { Address, PublicClient } from "viem";
import type { SupportedChain } from "../config/chains";
import { FEED_HEARTBEATS } from "../config/oracleBootstrap";
import type { LoggerLike } from "../bot";
import type { LocalPositionModel, TierChange } from "./localPositionModel";
import { chainlinkAggregatorAbi, type OracleFeedRegistry } from "../utils/priceOracleCache";

export interface LocalFeedFreshnessPollConfig {
  readonly client: PublicClient;
  readonly chain: SupportedChain;
  readonly model: LocalPositionModel;
  readonly feedRegistry: OracleFeedRegistry;
  readonly assets: readonly Address[];
  readonly logger?: LoggerLike;
}

type MulticallResult = {
  readonly status: "success" | "failure";
  readonly result?: unknown;
};

function parseLatestRoundData(result: unknown): { answer: bigint; updatedAt: number } | undefined {
  if (!Array.isArray(result) || result.length < 4) {
    return undefined;
  }
  const answer = result[1];
  const updatedAt = result[3];
  if (typeof answer !== "bigint" || typeof updatedAt !== "bigint") {
    return undefined;
  }
  if (answer <= 0n) {
    return undefined;
  }
  return { answer, updatedAt: Number(updatedAt) };
}

function parseFeedDecimals(result: unknown): number | undefined {
  if (typeof result === "number" && Number.isFinite(result)) {
    return result;
  }
  if (typeof result === "bigint") {
    return Number(result);
  }
  return undefined;
}

function isChainlinkRoundFresh(feed: Address, updatedAtSec: number, nowSec: number): boolean {
  const heartbeat = FEED_HEARTBEATS[feed.toLowerCase()] ?? 3600;
  return nowSec - updatedAtSec <= heartbeat * 1.5;
}

export async function pollLocalFeedFreshness(
  config: LocalFeedFreshnessPollConfig,
): Promise<readonly TierChange[]> {
  if (!config.model.isPricesBootstrapped()) {
    return [];
  }

  const chainFeeds = config.feedRegistry[config.chain] ?? {};
  const entries = config.assets
    .map((asset) => {
      const feedConfig = chainFeeds[asset];
      if (feedConfig?.feed === undefined) {
        return undefined;
      }
      return { asset, feed: feedConfig.feed };
    })
    .filter((entry): entry is { readonly asset: Address; readonly feed: Address } => entry !== undefined);

  if (entries.length === 0) {
    return [];
  }

  const contracts = entries.flatMap((entry) => [
    {
      address: entry.feed,
      abi: chainlinkAggregatorAbi,
      functionName: "latestRoundData" as const,
    },
    {
      address: entry.feed,
      abi: chainlinkAggregatorAbi,
      functionName: "decimals" as const,
    },
  ]);

  const results = await config.client.multicall({
    contracts,
    allowFailure: true,
  }) as readonly MulticallResult[];

  const nowSec = Math.floor(Date.now() / 1000);
  const allChanges: TierChange[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const lrdResponse = results[index * 2];
    const decResponse = results[index * 2 + 1];
    if (lrdResponse?.status !== "success" || decResponse?.status !== "success") {
      config.logger?.warn("local_feed_freshness_poll_failed", {
        asset: entry.asset,
        feed: entry.feed,
      });
      continue;
    }

    const round = parseLatestRoundData(lrdResponse.result);
    const decimals = parseFeedDecimals(decResponse.result);
    if (round === undefined || decimals === undefined) {
      config.logger?.warn("local_feed_freshness_poll_parse_failed", {
        asset: entry.asset,
        feed: entry.feed,
      });
      continue;
    }

    if (!isChainlinkRoundFresh(entry.feed, round.updatedAt, nowSec)) {
      config.logger?.warn("local_feed_freshness_poll_stale_round", {
        asset: entry.asset,
        feed: entry.feed,
        updatedAt: round.updatedAt,
        nowSec,
      });
      continue;
    }

    const changes = config.model.applyFeedPriceUpdate(
      entry.asset,
      entry.feed,
      round.answer,
      decimals,
      round.updatedAt,
    );
    allChanges.push(...changes);
  }

  return allChanges;
}
