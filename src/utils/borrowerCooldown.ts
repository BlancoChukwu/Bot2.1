import type { Address } from "viem";
import type { SupportedChain } from "../config/chains";

const defaultCooldownMs = 10 * 60 * 1_000;
const minCooldownMs = 5 * 60 * 1_000;
const maxCooldownMs = 15 * 60 * 1_000;

export interface BorrowerCooldownConfig {
  readonly cooldownMs?: number;
  readonly nowMs?: () => number;
}

export class BorrowerCooldownRegistry {
  private readonly blockedUntilMs = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly nowMs: () => number;

  public constructor(config: BorrowerCooldownConfig = {}) {
    const requested = config.cooldownMs ?? defaultCooldownMs;
    this.cooldownMs = Math.min(maxCooldownMs, Math.max(minCooldownMs, requested));
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  public blockBorrower(chain: SupportedChain, account: Address, reason: string): void {
    const key = borrowerKey(chain, account);
    this.blockedUntilMs.set(key, this.nowMs() + this.cooldownMs);
    this.lastReason.set(key, reason);
  }

  public isBorrowerBlocked(chain: SupportedChain, account: Address): boolean {
    const until = this.blockedUntilMs.get(borrowerKey(chain, account));
    if (until === undefined) {
      return false;
    }
    if (this.nowMs() >= until) {
      this.blockedUntilMs.delete(borrowerKey(chain, account));
      this.lastReason.delete(borrowerKey(chain, account));
      return false;
    }
    return true;
  }

  public remainingMs(chain: SupportedChain, account: Address): number {
    const until = this.blockedUntilMs.get(borrowerKey(chain, account));
    if (until === undefined) {
      return 0;
    }
    return Math.max(0, until - this.nowMs());
  }

  public blockedCount(): number {
    this.pruneExpired();
    return this.blockedUntilMs.size;
  }

  public lastBlockReason(chain: SupportedChain, account: Address): string | undefined {
    return this.lastReason.get(borrowerKey(chain, account));
  }

  private readonly lastReason = new Map<string, string>();

  private pruneExpired(): void {
    const now = this.nowMs();
    for (const [key, until] of this.blockedUntilMs) {
      if (now >= until) {
        this.blockedUntilMs.delete(key);
        this.lastReason.delete(key);
      }
    }
  }
}

function borrowerKey(chain: SupportedChain, account: Address): string {
  return `${chain}:${account.toLowerCase()}`;
}

export function clampBorrowerCooldownMs(value: number): number {
  return Math.min(maxCooldownMs, Math.max(minCooldownMs, value));
}
