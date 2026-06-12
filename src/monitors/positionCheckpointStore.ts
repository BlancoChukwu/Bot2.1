import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Redis from "ioredis";
import type { LoggerLike } from "../bot";
import type { BlockCursorStore } from "../utils/blockCursor";

export interface PositionCheckpointStoreConfig {
  readonly chain: string;
  readonly redisUrl?: string;
  readonly diskPath?: string;
  readonly logger?: LoggerLike;
}

class DiskBlockCursorStore implements BlockCursorStore {
  public constructor(private readonly filePath: string) {}

  public async get(key: string): Promise<string | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed[key] ?? null;
    } catch {
      return null;
    }
  }

  public async set(key: string, value: string): Promise<void> {
    let existing: Record<string, string> = {};
    try {
      const raw = await readFile(this.filePath, "utf8");
      existing = JSON.parse(raw) as Record<string, string>;
    } catch {
      existing = {};
    }
    existing[key] = value;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(existing, null, 2));
  }
}

export class PositionCheckpointStore {
  private readonly lastProcessedKey: string;
  private readonly bootstrapKey: string;

  public constructor(
    private readonly store: BlockCursorStore,
    config: PositionCheckpointStoreConfig,
  ) {
    this.lastProcessedKey = `bot:lastProcessedBlock:${config.chain}`;
    this.bootstrapKey = `bot:bootstrapChunkCursor:${config.chain}`;
  }

  public static async create(config: PositionCheckpointStoreConfig): Promise<PositionCheckpointStore> {
    const redisUrl = config.redisUrl?.trim();
    if (redisUrl !== undefined && redisUrl.length > 0) {
      const client = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
      try {
        await client.connect();
        await client.ping();
        config.logger?.info("position_checkpoint_redis_connected", { chain: config.chain });
        const store: BlockCursorStore = {
          get: (key) => client.get(key),
          set: async (key, value) => {
            await client.set(key, value);
          },
          close: async () => {
            await client.quit();
          },
        };
        return new PositionCheckpointStore(store, config);
      } catch (error) {
        config.logger?.warn("position_checkpoint_redis_failed", { chain: config.chain, error: String(error) });
        await client.quit().catch(() => undefined);
      }
    }
    const diskPath = config.diskPath ?? `.cache/position-checkpoint-${config.chain}.json`;
    config.logger?.info("position_checkpoint_disk", { chain: config.chain, path: diskPath });
    return new PositionCheckpointStore(new DiskBlockCursorStore(diskPath), config);
  }

  public async loadLastProcessedBlock(): Promise<bigint> {
    const val = await this.store.get(this.lastProcessedKey);
    return val === null ? 0n : BigInt(val);
  }

  public async saveLastProcessedBlock(blockNumber: bigint): Promise<void> {
    await this.store.set(this.lastProcessedKey, blockNumber.toString());
  }

  public async loadBootstrapChunkCursor(): Promise<bigint> {
    const val = await this.store.get(this.bootstrapKey);
    return val === null ? 0n : BigInt(val);
  }

  public async saveBootstrapChunkCursor(blockNumber: bigint): Promise<void> {
    await this.store.set(this.bootstrapKey, blockNumber.toString());
  }

  public async close(): Promise<void> {
    await this.store.close?.();
  }
}
