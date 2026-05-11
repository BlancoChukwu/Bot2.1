import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_STALE_MS = 120_000;
const DEFAULT_USD_DECIMALS = 8;

const chainlinkAggregatorAbi = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export interface OracleFeedConfig {
  readonly feed: Address;
  readonly priceDecimals?: number;
}

export type OracleFeedRegistry = Readonly<Record<SupportedChain, Readonly<Partial<Record<Address, OracleFeedConfig>>>>>;

interface PriceCacheEntry {
  readonly priceInUsdRaw: bigint;
  readonly updatedAtMs: number;
}

interface PriceOracleLogger {
  warn(message: string, meta?: unknown): void;
}

export interface PriceOracleCacheConfig {
  readonly publicClient: {
    readContract(args: Record<string, unknown>): Promise<unknown>;
    multicall(args: Record<string, unknown>): Promise<unknown>;
  };
  readonly chain: SupportedChain;
  readonly feedRegistry?: OracleFeedRegistry;
  readonly cacheTtlMs?: number;
  readonly maxStaleMs?: number;
  readonly logger?: PriceOracleLogger;
  readonly nowMs?: () => number;
}

/**
 * Low-latency USD oracle cache that is safe for arbitrage prefilters.
 * - Cache hit path: in-memory only
 * - Cache miss path: single multicall for batch requests
 * - In-flight dedupe: prevents N duplicate RPC calls under load
 */
export class PriceOracleCache {
  private readonly cache = new Map<Address, PriceCacheEntry>();
  private readonly inFlight = new Map<Address, Promise<bigint>>();
  private readonly feedDecimalsCache = new Map<Address, number>();
  private readonly cacheTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly nowMs: () => number;
  private readonly logger: PriceOracleLogger | undefined;
  private readonly feedsByToken: Readonly<Partial<Record<Address, OracleFeedConfig>>>;

  public constructor(private readonly config: PriceOracleCacheConfig) {
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxStaleMs = config.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
    this.nowMs = config.nowMs ?? (() => Date.now());
    this.logger = config.logger;
    this.feedsByToken = config.feedRegistry?.[config.chain] ?? {};
  }

  public async getUsdPrice(token: Address): Promise<bigint> {
    const cached = this.getFreshCached(token);
    if (cached !== undefined) {
      return cached;
    }

    const current = this.inFlight.get(token);
    if (current !== undefined) {
      return current;
    }

    const promise = this.fetchOne(token).finally(() => {
      this.inFlight.delete(token);
    });
    this.inFlight.set(token, promise);
    return promise;
  }

  public async batchGetUsdPrices(tokens: readonly Address[]): Promise<Partial<Record<Address, bigint>>> {
    const unique = dedupeAddresses(tokens);
    if (unique.length === 0) {
      return {};
    }

    const result: Partial<Record<Address, bigint>> = {};
    const missing: Address[] = [];
    for (const token of unique) {
      const cached = this.getFreshCached(token);
      if (cached !== undefined) {
        result[token] = cached;
      } else {
        missing.push(token);
      }
    }
    if (missing.length === 0) {
      return result;
    }

    const immediate: Address[] = [];
    const pending: Promise<void>[] = [];
    for (const token of missing) {
      const inFlight = this.inFlight.get(token);
      if (inFlight !== undefined) {
        pending.push(inFlight.then((price) => {
          result[token] = price;
        }));
      } else {
        immediate.push(token);
      }
    }

    if (immediate.length > 0) {
      await this.fetchMany(immediate, result);
    }
    if (pending.length > 0) {
      await Promise.all(pending);
    }

    return result;
  }

  public clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private getFreshCached(token: Address): bigint | undefined {
    const cached = this.cache.get(token);
    if (cached === undefined) {
      return undefined;
    }
    if (this.nowMs() - cached.updatedAtMs >= this.cacheTtlMs) {
      return undefined;
    }
    return cached.priceInUsdRaw;
  }

  private async fetchOne(token: Address): Promise<bigint> {
    const feed = this.feedsByToken[token];
    if (feed === undefined) {
      this.logger?.warn("price_oracle_missing_feed", { chain: this.config.chain, token });
      return 0n;
    }

    try {
      const roundData = await this.config.publicClient.readContract({
        address: feed.feed,
        abi: chainlinkAggregatorAbi,
        functionName: "latestRoundData",
      }) as readonly [bigint, bigint, bigint, bigint, bigint];
      const rawPrice = sanitizeOraclePrice(roundData[1]);
      const updatedAtSec = Number(roundData[3]);
      const scaled = await this.scaleToUsd8(feed, rawPrice);
      const fresh = this.guardFreshness(scaled, updatedAtSec, token);
      this.cache.set(token, { priceInUsdRaw: fresh, updatedAtMs: this.nowMs() });
      return fresh;
    } catch (error) {
      this.logger?.warn("price_oracle_read_failed", { chain: this.config.chain, token, error: toErrorMessage(error) });
      return 0n;
    }
  }

  private async fetchMany(tokens: readonly Address[], sink: Partial<Record<Address, bigint>>): Promise<void> {
    const feedEntries = tokens
      .map((token) => ({ token, config: this.feedsByToken[token] }))
      .filter((entry): entry is { readonly token: Address; readonly config: OracleFeedConfig } => entry.config !== undefined);
    if (feedEntries.length === 0) {
      for (const token of tokens) {
        this.logger?.warn("price_oracle_missing_feed", { chain: this.config.chain, token });
        sink[token] = 0n;
      }
      return;
    }

    for (const token of tokens) {
      if (this.feedsByToken[token] === undefined) {
        this.logger?.warn("price_oracle_missing_feed", { chain: this.config.chain, token });
        sink[token] = 0n;
      }
    }

    try {
      const responses = await this.config.publicClient.multicall({
        contracts: feedEntries.map((entry) => ({
          address: entry.config.feed,
          abi: chainlinkAggregatorAbi,
          functionName: "latestRoundData",
        })),
        allowFailure: true,
      }) as readonly { readonly status: "success" | "failure"; readonly result?: readonly [bigint, bigint, bigint, bigint, bigint] }[];

      for (let index = 0; index < feedEntries.length; index += 1) {
        const entry = feedEntries[index];
        if (entry === undefined) {
          continue;
        }
        const response = responses[index];
        if (response === undefined || response.status !== "success") {
          this.logger?.warn("price_oracle_multicall_entry_failed", {
            chain: this.config.chain,
            token: entry.token,
            feed: entry.config.feed,
          });
          sink[entry.token] = 0n;
          continue;
        }

        if (response.result === undefined) {
          sink[entry.token] = 0n;
          continue;
        }
        const raw = response.result;
        const rawPrice = sanitizeOraclePrice(raw[1]);
        const updatedAtSec = Number(raw[3]);
        const scaled = await this.scaleToUsd8(entry.config, rawPrice);
        const fresh = this.guardFreshness(scaled, updatedAtSec, entry.token);
        sink[entry.token] = fresh;
        this.cache.set(entry.token, { priceInUsdRaw: fresh, updatedAtMs: this.nowMs() });
      }
    } catch (error) {
      this.logger?.warn("price_oracle_multicall_failed", {
        chain: this.config.chain,
        tokenCount: feedEntries.length,
        error: toErrorMessage(error),
      });
      for (const entry of feedEntries) {
        sink[entry.token] = await this.fetchOne(entry.token);
      }
    }
  }

  private async scaleToUsd8(feed: OracleFeedConfig, rawPrice: bigint): Promise<bigint> {
    const feedDecimals = await this.resolveFeedDecimals(feed);
    if (feedDecimals === DEFAULT_USD_DECIMALS) {
      return rawPrice;
    }
    if (feedDecimals > DEFAULT_USD_DECIMALS) {
      return rawPrice / 10n ** BigInt(feedDecimals - DEFAULT_USD_DECIMALS);
    }
    return rawPrice * 10n ** BigInt(DEFAULT_USD_DECIMALS - feedDecimals);
  }

  private async resolveFeedDecimals(feed: OracleFeedConfig): Promise<number> {
    if (feed.priceDecimals !== undefined) {
      return feed.priceDecimals;
    }
    const cached = this.feedDecimalsCache.get(feed.feed);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const decimals = await this.config.publicClient.readContract({
        address: feed.feed,
        abi: chainlinkAggregatorAbi,
        functionName: "decimals",
      });
      const normalized = Number(decimals);
      this.feedDecimalsCache.set(feed.feed, normalized);
      return normalized;
    } catch {
      return DEFAULT_USD_DECIMALS;
    }
  }

  private guardFreshness(priceInUsdRaw: bigint, updatedAtSec: number, token: Address): bigint {
    if (priceInUsdRaw <= 0n) {
      return 0n;
    }
    if (!Number.isFinite(updatedAtSec) || updatedAtSec <= 0) {
      this.logger?.warn("price_oracle_invalid_updated_at", { chain: this.config.chain, token, updatedAtSec });
      return 0n;
    }
    const ageMs = this.nowMs() - updatedAtSec * 1_000;
    if (ageMs > this.maxStaleMs) {
      this.logger?.warn("price_oracle_stale_price", { chain: this.config.chain, token, ageMs, maxStaleMs: this.maxStaleMs });
      return 0n;
    }
    return priceInUsdRaw;
  }
}

function dedupeAddresses(tokens: readonly Address[]): Address[] {
  return [...new Set(tokens)];
}

function sanitizeOraclePrice(price: bigint): bigint {
  return price > 0n ? price : 0n;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
