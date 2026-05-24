const defaultIntervalMs = 60_000;
const defaultMaxEntries = 10_000;

export class DustLogCooldown {
  private readonly lastLoggedAtMs = new Map<string, number>();

  public constructor(
    private readonly intervalMs: number = defaultIntervalMs,
    private readonly maxEntries: number = defaultMaxEntries,
  ) {}

  public shouldLog(key: string, nowMs: number = Date.now()): boolean {
    const last = this.lastLoggedAtMs.get(key);
    if (last !== undefined && nowMs - last < this.intervalMs) {
      return false;
    }
    if (this.lastLoggedAtMs.size >= this.maxEntries) {
      this.lastLoggedAtMs.clear();
    }
    this.lastLoggedAtMs.set(key, nowMs);
    return true;
  }
}
