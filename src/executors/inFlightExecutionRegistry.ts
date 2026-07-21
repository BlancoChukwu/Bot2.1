export interface InFlightExecutionEntry {
  readonly opportunityId: string;
  readonly startedAtMs: number;
  readonly txHashes: readonly string[];
}

export interface WaitUntilEmptyResult {
  readonly drained: boolean;
  readonly remaining: readonly string[];
  readonly waitedMs: number;
}

/**
 * Process-local registry of flash-loan submissions awaiting receipt.
 * Increment only after a tx hash exists; decrement on terminal outcome.
 */
export class InFlightExecutionRegistry {
  private readonly entries = new Map<string, {
    startedAtMs: number;
    txHashes: string[];
    resolve: () => void;
    done: Promise<void>;
  }>();

  public size(): number {
    return this.entries.size;
  }

  public list(): readonly InFlightExecutionEntry[] {
    return [...this.entries.entries()].map(([opportunityId, entry]) => ({
      opportunityId,
      startedAtMs: entry.startedAtMs,
      txHashes: [...entry.txHashes],
    }));
  }

  /** Register after first successful send. Idempotent append for replacements. */
  public trackSubmitted(opportunityId: string, txHash: string, nowMs = Date.now()): void {
    const existing = this.entries.get(opportunityId);
    if (existing !== undefined) {
      existing.txHashes.push(txHash);
      return;
    }
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    this.entries.set(opportunityId, {
      startedAtMs: nowMs,
      txHashes: [txHash],
      resolve,
      done,
    });
  }

  public complete(opportunityId: string): void {
    const entry = this.entries.get(opportunityId);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(opportunityId);
    entry.resolve();
  }

  public async waitUntilEmpty(maxWaitMs: number, nowMs = () => Date.now()): Promise<WaitUntilEmptyResult> {
    const started = nowMs();
    if (this.entries.size === 0) {
      return { drained: true, remaining: [], waitedMs: 0 };
    }
    const pending = [...this.entries.values()].map((entry) => entry.done);
    await Promise.race([
      Promise.all(pending),
      sleep(maxWaitMs),
    ]);
    const waitedMs = Math.max(0, nowMs() - started);
    const remaining = [...this.entries.keys()];
    return {
      drained: remaining.length === 0,
      remaining,
      waitedMs,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
