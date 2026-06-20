import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";
import type { LoggerLike } from "../bot";
import type { BootstrapDiscoverySource } from "./bootstrapTypes";

export const DISCOVERY_CACHE_VERSION = 1 as const;

export interface DiscoveryCacheFile {
  readonly version: typeof DISCOVERY_CACHE_VERSION;
  readonly chain: SupportedChain;
  readonly savedAtMs: number;
  readonly blockNumber: string;
  readonly discoverySource: BootstrapDiscoverySource;
  readonly accounts: readonly string[];
  readonly withDebt: readonly string[];
}

export interface DiscoveryCacheStoreConfig {
  readonly chain: SupportedChain;
  readonly ttlHours: number;
  readonly diskPath?: string;
  readonly logger?: LoggerLike;
}

export class BootstrapDiscoveryCacheStore {
  private readonly filePath: string;

  public constructor(private readonly config: DiscoveryCacheStoreConfig) {
    this.filePath = config.diskPath ?? `.cache/bootstrap-discovery-${config.chain}.json`;
  }

  public async loadIfFresh(blockNumber: bigint): Promise<DiscoveryCacheFile | undefined> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DiscoveryCacheFile;
      if (parsed.version !== DISCOVERY_CACHE_VERSION || parsed.chain !== this.config.chain) {
        return undefined;
      }
      const ageMs = Date.now() - parsed.savedAtMs;
      const ttlMs = this.config.ttlHours * 3_600_000;
      if (ageMs > ttlMs) {
        this.config.logger?.info("discovery_cache_stale", {
          chain: this.config.chain,
          ageHours: ageMs / 3_600_000,
          ttlHours: this.config.ttlHours,
        });
        return undefined;
      }
      if (parsed.blockNumber !== blockNumber.toString()) {
        this.config.logger?.info("discovery_cache_block_mismatch", {
          chain: this.config.chain,
          cachedBlock: parsed.blockNumber,
          headBlock: blockNumber.toString(),
        });
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  public async save(snapshot: DiscoveryCacheFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(snapshot));
    this.config.logger?.info("discovery_cache_saved", {
      chain: this.config.chain,
      accounts: snapshot.accounts.length,
      withDebt: snapshot.withDebt.length,
      path: this.filePath,
    });
  }
}

export function addressesFromDiscoveryCache(file: DiscoveryCacheFile): {
  readonly accounts: readonly Address[];
  readonly withDebt: readonly Address[];
} {
  return {
    accounts: file.accounts.map((row) => row as Address),
    withDebt: file.withDebt.map((row) => row as Address),
  };
}

export function shouldForceBootstrapDiscoveryRefresh(): boolean {
  return (process.env.BOOTSTRAP_FORCE_REFRESH ?? "").trim().toLowerCase() === "true";
}
