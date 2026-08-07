import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address } from "viem";
import type { LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";

export const RECENT_LIQUIDATION_ATTEMPT_TTL_MS = 10 * 60 * 1_000;

export type RecentAttemptStatus = "submitted" | "included" | "reverted" | "unknown";

export interface RecentLiquidationAttempt {
  readonly chain: SupportedChain;
  readonly account: Address;
  readonly collateralAsset: Address;
  readonly debtAsset: Address;
  readonly txHash: `0x${string}`;
  readonly submittedAtMs: number;
  readonly status: RecentAttemptStatus;
}

export interface RecentAttemptStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del?(key: string): Promise<void>;
}

export interface ReceiptLookup {
  (txHash: `0x${string}`): Promise<"pending" | "included" | "reverted" | "not_found">;
}

export interface RecentLiquidationAttemptLedgerConfig {
  readonly store: RecentAttemptStore;
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
  readonly logger?: LoggerLike;
}

function attemptKey(
  chain: SupportedChain,
  account: Address,
  collateralAsset: Address,
  debtAsset: Address,
): string {
  return `bot:liq-attempt:${chain}:${account.toLowerCase()}:${collateralAsset.toLowerCase()}:${debtAsset.toLowerCase()}`;
}

/**
 * Durable short-TTL ledger of recent liquidation submissions.
 * Survives restart so a new process does not double-submit while the first
 * tx is still pending/just-confirmed. Reverts clear the block immediately.
 */
export class RecentLiquidationAttemptLedger {
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private readonly memory = new Map<string, RecentLiquidationAttempt>();

  public constructor(private readonly config: RecentLiquidationAttemptLedgerConfig) {
    this.ttlMs = config.ttlMs ?? RECENT_LIQUIDATION_ATTEMPT_TTL_MS;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  public static createDiskStore(filePath: string): RecentAttemptStore {
    return {
      get: async (key) => {
        try {
          const raw = await readFile(filePath, "utf8");
          const parsed = JSON.parse(raw) as Record<string, string>;
          return parsed[key] ?? null;
        } catch {
          return null;
        }
      },
      set: async (key, value) => {
        let existing: Record<string, string> = {};
        try {
          const raw = await readFile(filePath, "utf8");
          existing = JSON.parse(raw) as Record<string, string>;
        } catch {
          existing = {};
        }
        existing[key] = value;
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(existing, null, 2));
      },
      del: async (key) => {
        let existing: Record<string, string> = {};
        try {
          const raw = await readFile(filePath, "utf8");
          existing = JSON.parse(raw) as Record<string, string>;
        } catch {
          return;
        }
        delete existing[key];
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(existing, null, 2));
      },
    };
  }

  public async recordSubmitted(input: Omit<RecentLiquidationAttempt, "status" | "submittedAtMs"> & {
    readonly submittedAtMs?: number;
  }): Promise<void> {
    const entry: RecentLiquidationAttempt = {
      ...input,
      submittedAtMs: input.submittedAtMs ?? this.nowMs(),
      status: "submitted",
    };
    await this.write(entry);
  }

  public async markIncluded(input: {
    readonly chain: SupportedChain;
    readonly account: Address;
    readonly collateralAsset: Address;
    readonly debtAsset: Address;
  }): Promise<void> {
    const current = await this.read(input);
    if (current === undefined) {
      return;
    }
    await this.write({ ...current, status: "included" });
  }

  /**
   * Immediate clear on known revert — must not leave the candidate blocked
   * for the remainder of the TTL once failure is known.
   */
  public async markReverted(input: {
    readonly chain: SupportedChain;
    readonly account: Address;
    readonly collateralAsset: Address;
    readonly debtAsset: Address;
  }): Promise<void> {
    const key = attemptKey(input.chain, input.account, input.collateralAsset, input.debtAsset);
    this.memory.delete(key);
    if (this.config.store.del !== undefined) {
      await this.config.store.del(key);
      return;
    }
    await this.config.store.set(key, JSON.stringify({
      ...input,
      txHash: "0x",
      submittedAtMs: 0,
      status: "reverted",
    } satisfies RecentLiquidationAttempt));
  }

  public async isBlocked(input: {
    readonly chain: SupportedChain;
    readonly account: Address;
    readonly collateralAsset: Address;
    readonly debtAsset: Address;
  }): Promise<boolean> {
    const entry = await this.read(input);
    if (entry === undefined) {
      return false;
    }
    if (entry.status === "reverted") {
      return false;
    }
    if (this.nowMs() - entry.submittedAtMs > this.ttlMs) {
      await this.markReverted(input);
      return false;
    }
    return entry.status === "submitted" || entry.status === "included" || entry.status === "unknown";
  }

  /**
   * Boot/runtime reconciliation: refresh ledger from chain receipts.
   * Reverts clear the block immediately.
   */
  public async reconcile(
    entries: readonly RecentLiquidationAttempt[],
    lookup: ReceiptLookup,
  ): Promise<void> {
    for (const entry of entries) {
      const age = this.nowMs() - entry.submittedAtMs;
      if (age > this.ttlMs) {
        await this.markReverted(entry);
        continue;
      }
      const receipt = await lookup(entry.txHash);
      if (receipt === "reverted" || receipt === "not_found") {
        this.config.logger?.info("recent_liquidation_attempt_cleared", {
          reason: receipt,
          opportunityId: `${entry.chain}:${entry.account}:${entry.debtAsset}`,
          txHash: entry.txHash,
        });
        await this.markReverted(entry);
        continue;
      }
      if (receipt === "included") {
        await this.markIncluded(entry);
        continue;
      }
      // pending → keep submitted block
      await this.write({ ...entry, status: "submitted" });
    }
  }

  public async loadActive(): Promise<RecentLiquidationAttempt[]> {
    // Disk/redis stores are key-value; memory mirror holds what this process wrote.
    // For restart tests, seed via recordSubmitted then construct a new ledger on same store
    // and call hydrateFromStoreKeys when available. Here we return memory + optional scan.
    const out: RecentLiquidationAttempt[] = [];
    for (const entry of this.memory.values()) {
      if (entry.status !== "reverted" && this.nowMs() - entry.submittedAtMs <= this.ttlMs) {
        out.push(entry);
      }
    }
    return out;
  }

  /** Load a single key from durable store into memory (restart hydrate helper). */
  public async hydrateKey(input: {
    readonly chain: SupportedChain;
    readonly account: Address;
    readonly collateralAsset: Address;
    readonly debtAsset: Address;
  }): Promise<RecentLiquidationAttempt | undefined> {
    return this.read(input);
  }

  private async read(input: {
    readonly chain: SupportedChain;
    readonly account: Address;
    readonly collateralAsset: Address;
    readonly debtAsset: Address;
  }): Promise<RecentLiquidationAttempt | undefined> {
    const key = attemptKey(input.chain, input.account, input.collateralAsset, input.debtAsset);
    const cached = this.memory.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const raw = await this.config.store.get(key);
    if (raw === null) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as RecentLiquidationAttempt;
      this.memory.set(key, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async write(entry: RecentLiquidationAttempt): Promise<void> {
    const key = attemptKey(entry.chain, entry.account, entry.collateralAsset, entry.debtAsset);
    this.memory.set(key, entry);
    await this.config.store.set(key, JSON.stringify(entry));
  }
}
