export class RpcHealthMonitor {
  private readonly samples: Array<{ atMs: number; rttMs: number }> = [];

  public constructor(
    private readonly thresholdMs: number,
    private readonly windowMs: number,
  ) {}

  public observe(rttMs: number, atMs = Date.now()): void {
    this.samples.push({ atMs, rttMs });
    this.prune(atMs);
  }

  public isSustainedHigh(atMs = Date.now()): boolean {
    this.prune(atMs);
    if (this.samples.length === 0) {
      return false;
    }
    return this.samples.every((sample) => sample.rttMs > this.thresholdMs);
  }

  private prune(nowMs: number): void {
    while (this.samples.length > 0) {
      const first = this.samples[0];
      if (first === undefined || nowMs - first.atMs <= this.windowMs) {
        break;
      }
      this.samples.shift();
    }
  }
}

