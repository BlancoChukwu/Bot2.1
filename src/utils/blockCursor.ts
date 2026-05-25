import Redis from "ioredis";
import type { LoggerLike } from "../bot";

export type BlockCursorBackend = "redis" | "memory";

export interface BlockCursorStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  close?(): Promise<void>;
}

class InMemoryBlockCursorStore implements BlockCursorStore {
  private readonly values = new Map<string, string>();

  public async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  public async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

class RedisBlockCursorStore implements BlockCursorStore {
  private readonly client: Redis;

  public constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  public async ping(): Promise<void> {
    await this.client.connect();
    const pong = await this.client.ping();
    if (pong !== "PONG") {
      throw new Error(`Redis ping failed: ${pong}`);
    }
  }

  public async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  public async set(key: string, value: string): Promise<void> {
    await this.client.set(key, value);
  }

  public async close(): Promise<void> {
    await this.client.quit();
  }
}

export class BlockCursor {
  public constructor(
    private readonly store: BlockCursorStore,
    private readonly key: string,
    public readonly backend: BlockCursorBackend,
  ) {}

  public async load(): Promise<bigint> {
    const val = await this.store.get(this.key);
    return val === null ? 0n : BigInt(val);
  }

  public async save(blockNumber: bigint): Promise<void> {
    await this.store.set(this.key, blockNumber.toString());
  }

  public async close(): Promise<void> {
    await this.store.close?.();
  }
}

const IN_MEMORY_SURVIVAL_WARNING =
  "Gap replay cursor is in-memory only — state is LOST on every restart. Set REDIS_URL for production.";

export async function createBlockCursor(
  chain: string,
  options: { readonly redisUrl?: string; readonly logger?: LoggerLike } = {},
): Promise<BlockCursor> {
  const key = `bot:lastProcessedBlock:${chain}`;
  const redisUrl = options.redisUrl?.trim();

  if (redisUrl !== undefined && redisUrl.length > 0) {
    const redisStore = new RedisBlockCursorStore(redisUrl);
    try {
      await redisStore.ping();
      options.logger?.info("block_cursor_redis_connected", { chain, backend: "redis" });
      return new BlockCursor(redisStore, key, "redis");
    } catch (error) {
      options.logger?.error("block_cursor_redis_failed", {
        chain,
        error: String(error),
        fallback: "memory",
      });
      await redisStore.close().catch(() => undefined);
    }
  }

  options.logger?.error("block_cursor_in_memory", {
    chain,
    backend: "memory",
    message: IN_MEMORY_SURVIVAL_WARNING,
  });
  return new BlockCursor(new InMemoryBlockCursorStore(), key, "memory");
}
