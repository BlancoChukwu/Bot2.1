const DEFAULT_MAX_STALE_MS = 60_000;

export type StalenessStatus = "fresh" | "stale" | "critical";

export class StalenessGuard {
  private lastUpdate = Date.now();

  public constructor(private readonly maxStaleMs = DEFAULT_MAX_STALE_MS) {}

  public record(): void {
    this.lastUpdate = Date.now();
  }

  public check(): StalenessStatus {
    const age = Date.now() - this.lastUpdate;
    if (age < this.maxStaleMs) {
      return "fresh";
    }
    if (age < this.maxStaleMs * 3) {
      return "stale";
    }
    return "critical";
  }

  public ageMs(): number {
    return Date.now() - this.lastUpdate;
  }

  public getMaxStaleMs(): number {
    return this.maxStaleMs;
  }
}
