import type { SupportedChain } from "../config/chains";
import type { ArbitrageOpportunity, ArbitrageOpportunitySink } from "./arbitrageScanner";

export interface ArbitrageOpportunityQueueConfig {
  readonly maxEntriesPerChain?: number;
  readonly dedupeWindowMs?: number;
}

export class ArbitrageOpportunityQueue implements ArbitrageOpportunitySink {
  private readonly opportunities = new Map<SupportedChain, ArbitrageOpportunity[]>();
  private readonly seen = new Map<string, number>();
  private readonly maxEntriesPerChain: number;
  private readonly dedupeWindowMs: number;
  private seenPruneTimer: NodeJS.Timeout | undefined;

  public constructor(config: ArbitrageOpportunityQueueConfig = {}) {
    this.maxEntriesPerChain = config.maxEntriesPerChain ?? 500;
    this.dedupeWindowMs = config.dedupeWindowMs ?? 60_000;
    this.seenPruneTimer = setInterval(() => this.pruneSeen(), 60_000);
    this.seenPruneTimer.unref?.();
  }

  public push(opportunity: ArbitrageOpportunity): void {
    this.pruneSeen();
    const now = Date.now();
    if (this.seen.has(opportunity.opportunityId)) {
      return;
    }
    this.seen.set(opportunity.opportunityId, now);
    const queue = this.opportunities.get(opportunity.chain) ?? [];
    queue.push(opportunity);
    while (queue.length > this.maxEntriesPerChain) {
      queue.shift();
    }
    this.opportunities.set(opportunity.chain, queue);
  }

  public drain(chain: SupportedChain): ArbitrageOpportunity[] {
    const queued = this.opportunities.get(chain) ?? [];
    this.opportunities.set(chain, []);
    return queued;
  }

  public stop(): void {
    if (this.seenPruneTimer !== undefined) {
      clearInterval(this.seenPruneTimer);
      this.seenPruneTimer = undefined;
    }
    this.seen.clear();
  }

  private pruneSeen(): void {
    const threshold = Date.now() - this.dedupeWindowMs;
    for (const [key, seenAt] of this.seen.entries()) {
      if (seenAt < threshold) {
        this.seen.delete(key);
      }
    }
  }
}
