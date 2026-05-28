const DEFAULT_MAX = 50_000;
const DEFAULT_STALE_BLOCKS = 50_400n;

export interface BoundedWatchlistEntry {
  readonly lastSeen: bigint;
  readonly lastHealthFactor?: bigint;
}

export class BoundedWatchlist {
  private readonly map = new Map<string, BoundedWatchlistEntry>();

  public constructor(
    private readonly maxSize = DEFAULT_MAX,
    private readonly staleBlocks = DEFAULT_STALE_BLOCKS,
  ) {}

  public add(address: string, blockNumber: bigint, lastHealthFactor?: bigint): void {
    const key = address.toLowerCase();
    if (this.map.size >= this.maxSize) {
      this.evictStale(blockNumber);
    }
    const existing = this.map.get(key);
    const hf = lastHealthFactor ?? existing?.lastHealthFactor;
    const entry: BoundedWatchlistEntry = hf === undefined
      ? { lastSeen: blockNumber }
      : { lastSeen: blockNumber, lastHealthFactor: hf };
    this.map.set(key, entry);
  }

  public updateHealthFactor(address: string, healthFactor: bigint): void {
    const key = address.toLowerCase();
    const existing = this.map.get(key);
    if (existing === undefined) {
      return;
    }
    this.map.set(key, { ...existing, lastHealthFactor: healthFactor });
  }

  public addresses(): string[] {
    return [...this.map.keys()];
  }

  public size(): number {
    return this.map.size;
  }

  public remove(address: string): boolean {
    return this.map.delete(address.toLowerCase());
  }

  public entries(): ReadonlyMap<string, BoundedWatchlistEntry> {
    return this.map;
  }

  private evictStale(currentBlock: bigint): void {
    for (const [addr, entry] of this.map) {
      if (currentBlock - entry.lastSeen > this.staleBlocks) {
        this.map.delete(addr);
      }
    }
  }
}
