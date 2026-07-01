import { getAddress, isAddress, type Address } from "viem";
import type { SupportedChain } from "../config/chains";
import { BASE_PROTOCOL_DATA_PROVIDER } from "../config/oracleBootstrap";

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_STALE_MS = 900_000;
const DEFAULT_USD_DECIMALS = 8;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

export const chainlinkAggregatorAbi = [
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

const aaveOracleAbi = [
  {
    name: "getAssetPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface OracleFeedConfig {
  readonly feed: Address;
  readonly priceDecimals?: number;
}

export type OracleFeedRegistry = Readonly<Record<SupportedChain, Readonly<Partial<Record<Address, OracleFeedConfig>>>>>;

export type OraclePriceSource = "chainlink" | "aave";

interface PriceCacheEntry {
  readonly priceInUsdRaw: bigint;
  readonly updatedAtMs: number;
  readonly oracleUpdatedAtSec: number;
  readonly source: OraclePriceSource;
  readonly freshnessMs: number;
}

interface PriceOracleLogger {
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface OracleFreshnessObservation {
  readonly chain: SupportedChain;
  readonly token: Address;
  readonly freshnessMs: number;
  readonly source: OraclePriceSource;
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
  readonly aaveOracleAddress?: Address;
  readonly logger?: PriceOracleLogger;
  readonly nowMs?: () => number;
  readonly onFreshnessObserved?: (observation: OracleFreshnessObservation) => void;
  readonly heartbeatWarnMs?: number;
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
  private readonly heartbeatWarnMs: number;
  private readonly nowMs: () => number;
  private readonly logger: PriceOracleLogger | undefined;
  private readonly feedsByToken: Readonly<Partial<Record<Address, OracleFeedConfig>>>;
  private readonly onFreshnessObserved: ((observation: OracleFreshnessObservation) => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly config: PriceOracleCacheConfig) {
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxStaleMs = config.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
    this.heartbeatWarnMs = config.heartbeatWarnMs ?? this.maxStaleMs;
    this.nowMs = config.nowMs ?? (() => Date.now());
    this.logger = config.logger;
    this.onFreshnessObserved = config.onFreshnessObserved;
    this.feedsByToken = sanitizeFeedsByToken(
      config.feedRegistry?.[config.chain] ?? {},
      config.chain,
      this.logger,
    );
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

  public async forceRefreshUsdPrices(tokens: readonly Address[]): Promise<Partial<Record<Address, bigint>>> {
    for (const token of dedupeAddresses(tokens)) {
      this.cache.delete(token);
      this.inFlight.delete(token);
    }
    return this.batchGetUsdPrices(tokens);
  }

  public getOracleFreshnessMs(token: Address): number | undefined {
    return this.cache.get(token)?.freshnessMs;
  }

  public startBackgroundPoll(tokens: readonly Address[], intervalMs = DEFAULT_POLL_INTERVAL_MS): () => void {
    this.stopBackgroundPoll();
    const unique = dedupeAddresses(tokens);
    if (unique.length === 0) {
      return () => undefined;
    }
    const poll = () => {
      void this.forceRefreshUsdPrices(unique).catch((error) => {
        this.logger?.warn("price_oracle_background_poll_failed", {
          chain: this.config.chain,
          error: toErrorMessage(error),
        });
      });
    };
    poll();
    this.pollTimer = setInterval(poll, intervalMs);
    return () => this.stopBackgroundPoll();
  }

  public stopBackgroundPoll(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  public clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.stopBackgroundPoll();
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
    const feed = this.resolveValidatedFeedConfig(token);
    if (feed === undefined) {
      this.logger?.warn("price_oracle_missing_feed", { chain: this.config.chain, token });
      return this.readAaveFallback(token);
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
      const fresh = this.guardFreshness(scaled, updatedAtSec, token, "chainlink", false);
      if (fresh > 0n) {
        return fresh;
      }
      return this.readAaveFallback(token);
    } catch (error) {
      this.logger?.warn("price_oracle_read_failed", { chain: this.config.chain, token, error: toErrorMessage(error) });
      return this.readAaveFallback(token);
    }
  }

  private async fetchMany(tokens: readonly Address[], sink: Partial<Record<Address, bigint>>): Promise<void> {
    const feedEntries = tokens
      .map((token) => {
        const config = this.resolveValidatedFeedConfig(token);
        return config === undefined ? undefined : { token, config };
      })
      .filter((entry): entry is { readonly token: Address; readonly config: OracleFeedConfig } => entry !== undefined);
    if (feedEntries.length === 0) {
      for (const token of tokens) {
        this.logger?.warn("price_oracle_missing_feed", { chain: this.config.chain, token });
        sink[token] = await this.readAaveFallback(token);
      }
      return;
    }

    for (const token of tokens) {
      if (this.resolveValidatedFeedConfig(token) === undefined) {
        this.logger?.warn("price_oracle_missing_feed", { chain: this.config.chain, token });
        sink[token] = await this.readAaveFallback(token);
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
        if (response === undefined || response.status !== "success" || response.result === undefined) {
          this.logger?.warn("price_oracle_multicall_entry_failed", {
            chain: this.config.chain,
            token: entry.token,
            feed: entry.config.feed,
          });
          sink[entry.token] = await this.readAaveFallback(entry.token);
          continue;
        }

        const raw = response.result;
        const rawPrice = sanitizeOraclePrice(raw[1]);
        const updatedAtSec = Number(raw[3]);
        const scaled = await this.scaleToUsd8(entry.config, rawPrice);
        const fresh = this.guardFreshness(scaled, updatedAtSec, entry.token, "chainlink", false);
        sink[entry.token] = fresh > 0n ? fresh : await this.readAaveFallback(entry.token);
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

  private async readAaveFallback(token: Address): Promise<bigint> {
    if (this.config.aaveOracleAddress === undefined) {
      this.logOracleUntrustedCritical(token, "aave_oracle_not_configured");
      return 0n;
    }
    try {
      const raw = await this.config.publicClient.readContract({
        address: this.config.aaveOracleAddress,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [token],
      }) as bigint;
      const sanitized = sanitizeOraclePrice(raw);
      if (sanitized <= 0n) {
        this.logOracleUntrustedCritical(token, "aave_oracle_zero_price");
        return 0n;
      }
      return this.storePrice(token, sanitized, Math.floor(this.nowMs() / 1_000), "aave");
    } catch (error) {
      this.logger?.warn("price_oracle_aave_fallback_failed", {
        chain: this.config.chain,
        token,
        error: toErrorMessage(error),
      });
      this.logOracleUntrustedCritical(token, "aave_oracle_read_failed");
      return 0n;
    }
  }

  private logOracleUntrustedCritical(token: Address, cause: string): void {
    this.logger?.error("price_oracle_untrusted_critical", {
      chain: this.config.chain,
      token,
      cause,
      sources: ["chainlink", "aave"],
      message: "Both Chainlink and Aave oracle paths failed or returned stale/zero — debt USD must not use cache fallback",
    });
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

  private resolveValidatedFeedConfig(token: Address): OracleFeedConfig | undefined {
    const config = this.feedsByToken[token];
    if (config === undefined) {
      return undefined;
    }
    const normalizedFeed = validateAndNormalizeFeedAddress(token, config.feed, {
      chain: this.config.chain,
      logger: this.logger,
    });
    if (normalizedFeed === undefined) {
      return undefined;
    }
    if (normalizedFeed === config.feed) {
      return config;
    }
    return { ...config, feed: normalizedFeed };
  }

  private async resolveFeedDecimals(feed: OracleFeedConfig): Promise<number> {
    if (feed.priceDecimals !== undefined) {
      return feed.priceDecimals;
    }
    const normalizedFeed = validateAndNormalizeFeedAddress(feed.feed, feed.feed, {
      chain: this.config.chain,
      logger: this.logger,
    });
    if (normalizedFeed === undefined) {
      return DEFAULT_USD_DECIMALS;
    }
    const cached = this.feedDecimalsCache.get(normalizedFeed);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const decimals = await this.config.publicClient.readContract({
        address: normalizedFeed,
        abi: chainlinkAggregatorAbi,
        functionName: "decimals",
      });
      const normalized = Number(decimals);
      this.feedDecimalsCache.set(normalizedFeed, normalized);
      return normalized;
    } catch {
      return DEFAULT_USD_DECIMALS;
    }
  }

  private guardFreshness(
    priceInUsdRaw: bigint,
    updatedAtSec: number,
    token: Address,
    source: OraclePriceSource,
    logStaleWarning = true,
  ): bigint {
    if (priceInUsdRaw <= 0n) {
      return 0n;
    }
    if (!Number.isFinite(updatedAtSec) || updatedAtSec <= 0) {
      this.logger?.warn("price_oracle_invalid_updated_at", { chain: this.config.chain, token, updatedAtSec });
      return 0n;
    }
    const freshnessMs = this.nowMs() - updatedAtSec * 1_000;
    if (freshnessMs > this.maxStaleMs) {
      if (logStaleWarning) {
        this.logger?.warn("price_oracle_stale_price", {
          chain: this.config.chain,
          token,
          ageMs: freshnessMs,
          maxStaleMs: this.maxStaleMs,
        });
      }
      return 0n;
    }
    return this.storePrice(token, priceInUsdRaw, updatedAtSec, source, freshnessMs);
  }

  private storePrice(
    token: Address,
    priceInUsdRaw: bigint,
    updatedAtSec: number,
    source: OraclePriceSource,
    freshnessMs = this.nowMs() - updatedAtSec * 1_000,
  ): bigint {
    if (priceInUsdRaw <= 0n) {
      return 0n;
    }
    this.cache.set(token, {
      priceInUsdRaw,
      updatedAtMs: this.nowMs(),
      oracleUpdatedAtSec: updatedAtSec,
      source,
      freshnessMs,
    });
    this.onFreshnessObserved?.({
      chain: this.config.chain,
      token,
      freshnessMs,
      source,
    });
    if (freshnessMs > this.heartbeatWarnMs) {
      this.logger?.warn("price_oracle_heartbeat_stale", {
        chain: this.config.chain,
        token,
        freshnessMs,
        heartbeatWarnMs: this.heartbeatWarnMs,
        source,
      });
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

/** Base mainnet Chainlink ETH/USD — must not use mainnet L1 feed addresses on Base. */
export const canonicalBaseEthUsdFeed = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as Address;

/** Base mainnet Chainlink USDC/USD. */
export const canonicalBaseUsdcUsdFeed = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B" as Address;

/** Base mainnet Chainlink cbBTC/USD. */
export const canonicalBaseCbBtcUsdFeed = "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D" as Address;

/** Aave V3 Base AaveOracle — verified on-chain 2026-05-20. */
export const canonicalBaseAaveOracleAddress = "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156" as Address;

const canonicalBaseUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const canonicalBaseWeth = "0x4200000000000000000000000000000000000006" as Address;
const canonicalBaseCbBtc = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;

const NON_CHAINLINK_FEED_ADDRESSES = new Set([
  BASE_PROTOCOL_DATA_PROVIDER.toLowerCase(),
  canonicalBaseAaveOracleAddress.toLowerCase(),
]);

const CRITICAL_BASE_FEED_EXPECTATIONS: readonly {
  readonly token: Address;
  readonly expectedFeed: Address;
}[] = [
  { token: canonicalBaseWeth, expectedFeed: canonicalBaseEthUsdFeed },
  { token: canonicalBaseUsdc, expectedFeed: canonicalBaseUsdcUsdFeed },
  { token: canonicalBaseCbBtc, expectedFeed: canonicalBaseCbBtcUsdFeed },
];

export function validateAndNormalizeFeedAddress(
  token: Address,
  feed: Address | string | undefined,
  context: { readonly chain: SupportedChain; readonly logger?: PriceOracleLogger },
): Address | undefined {
  if (feed === undefined || feed === null || feed === "") {
    context.logger?.error("price_oracle_invalid_feed_address", {
      chain: context.chain,
      token,
      feed,
      reason: "missing",
    });
    return undefined;
  }
  if (!isAddress(feed, { strict: false })) {
    context.logger?.error("price_oracle_invalid_feed_address", {
      chain: context.chain,
      token,
      feed,
      reason: "not_an_address",
    });
    return undefined;
  }
  let normalized: Address;
  try {
    normalized = getAddress(feed);
  } catch {
    context.logger?.error("price_oracle_invalid_feed_address", {
      chain: context.chain,
      token,
      feed,
      reason: "checksum_normalization_failed",
    });
    return undefined;
  }
  if (NON_CHAINLINK_FEED_ADDRESSES.has(normalized.toLowerCase())) {
    context.logger?.error("price_oracle_invalid_feed_address", {
      chain: context.chain,
      token,
      feed: normalized,
      reason: "denylisted_non_chainlink_contract",
    });
    return undefined;
  }
  return normalized;
}

function sanitizeFeedsByToken(
  raw: Readonly<Partial<Record<Address, OracleFeedConfig>>>,
  chain: SupportedChain,
  logger: PriceOracleLogger | undefined,
): Readonly<Partial<Record<Address, OracleFeedConfig>>> {
  const sanitized: Partial<Record<Address, OracleFeedConfig>> = {};
  for (const [token, config] of Object.entries(raw)) {
    if (config === undefined) {
      continue;
    }
    const tokenAddr = token as Address;
    const normalizedFeed = validateAndNormalizeFeedAddress(tokenAddr, config.feed, { chain, logger });
    if (normalizedFeed === undefined) {
      continue;
    }
    sanitized[tokenAddr] = {
      ...config,
      feed: normalizedFeed,
    };
  }
  return sanitized;
}

export function assertBaseFeedRegistry(feedRegistry: OracleFeedRegistry | undefined): void {
  const baseFeeds = feedRegistry?.base;
  if (baseFeeds === undefined) {
    throw new Error("Base price feed registry is required");
  }
  for (const { token, expectedFeed } of CRITICAL_BASE_FEED_EXPECTATIONS) {
    const configured = baseFeeds[token]?.feed;
    if (configured === undefined) {
      throw new Error(`Base feed is missing from price feed registry for token ${token}`);
    }
    const normalized = validateAndNormalizeFeedAddress(token, configured, { chain: "base" });
    if (normalized === undefined) {
      throw new Error(`Base feed address is invalid for token ${token}: ${configured}`);
    }
    if (normalized.toLowerCase() !== expectedFeed.toLowerCase()) {
      throw new Error(`Base feed for ${token} must be ${expectedFeed}, got ${configured}`);
    }
  }
}
