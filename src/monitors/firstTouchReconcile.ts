import type { Address } from "viem";
import type { LoggerLike } from "../bot";
import type { ReconcileSeedOutcome } from "./positionOnChainReconcile";

export const FIRST_TOUCH_RECONCILE_MAX_ATTEMPTS = 3;
/** Base delays before attempts 2 and 3 (attempt 1 is immediate). */
export const FIRST_TOUCH_RECONCILE_BACKOFF_MS = [250, 1_000, 3_000] as const;

export interface NeedsManualReconcileEntry {
  readonly reason: string;
  readonly attempts: number;
  readonly lastError: string;
  readonly firstSeenBlock: bigint;
  readonly lastAttemptAt: number;
}

export type FirstTouchReconcileTerminal =
  | { readonly status: "seeded" }
  | { readonly status: "benign_skip"; readonly reason: "no_debt" | "allowlist_miss" }
  | { readonly status: "dead_lettered"; readonly entry: NeedsManualReconcileEntry };

export interface FirstTouchReconcileRetryInput {
  readonly chain: string;
  readonly account: Address;
  readonly blockNumber: bigint;
  readonly logger: LoggerLike;
  readonly needsManualReconcile: Map<string, NeedsManualReconcileEntry>;
  /** Remove the partial live position (required on dead-letter). */
  readonly removePartialPosition: () => void;
  readonly attemptReconcile: () => Promise<ReconcileSeedOutcome>;
  readonly maxAttempts?: number;
  readonly sleepMs?: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
  /** Returns [0, 1) for ±20% jitter. */
  readonly random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function computeFirstTouchBackoffMs(
  attemptIndexZeroBased: number,
  random: () => number = Math.random,
): number {
  const base = FIRST_TOUCH_RECONCILE_BACKOFF_MS[
    Math.min(attemptIndexZeroBased, FIRST_TOUCH_RECONCILE_BACKOFF_MS.length - 1)
  ]!;
  const jitter = 0.8 + random() * 0.4; // ±20%
  return Math.round(base * jitter);
}

/**
 * Bounded retry (3) with backoff+jitter, then dead-letter:
 * remove partial live position and record needsManualReconcile.
 */
export async function reconcileFirstTouchWithRetry(
  input: FirstTouchReconcileRetryInput,
): Promise<FirstTouchReconcileTerminal> {
  const maxAttempts = input.maxAttempts ?? FIRST_TOUCH_RECONCILE_MAX_ATTEMPTS;
  const sleepMs = input.sleepMs ?? defaultSleep;
  const nowMs = input.nowMs ?? Date.now;
  const random = input.random ?? Math.random;
  const accountKey = input.account.toLowerCase();

  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      const delayMs = computeFirstTouchBackoffMs(attempt - 2, random);
      await sleepMs(delayMs);
    }

    const outcome = await input.attemptReconcile();
    if (outcome.status === "seeded") {
      input.needsManualReconcile.delete(accountKey);
      input.logger.info("position_first_touch_reconciled", {
        chain: input.chain,
        account: input.account,
        blockNumber: Number(input.blockNumber),
        attempt,
      });
      return { status: "seeded" };
    }

    if (outcome.status === "benign_skip") {
      input.needsManualReconcile.delete(accountKey);
      input.logger.info("position_first_touch_reconcile_skipped_benign", {
        chain: input.chain,
        account: input.account,
        blockNumber: Number(input.blockNumber),
        reason: outcome.reason,
      });
      return { status: "benign_skip", reason: outcome.reason };
    }

    lastError = outcome.error;
    input.logger.info("position_first_touch_reconcile_retry", {
      chain: input.chain,
      account: input.account,
      blockNumber: Number(input.blockNumber),
      attempt,
      maxAttempts,
      error: lastError,
    });
  }

  input.removePartialPosition();
  const entry: NeedsManualReconcileEntry = {
    reason: "reconcile_failed_after_retries",
    attempts: maxAttempts,
    lastError,
    firstSeenBlock: input.blockNumber,
    lastAttemptAt: nowMs(),
  };
  input.needsManualReconcile.set(accountKey, entry);
  input.logger.info("position_first_touch_reconcile_dead_lettered", {
    chain: input.chain,
    account: input.account,
    blockNumber: Number(input.blockNumber),
    attempts: entry.attempts,
    lastError: entry.lastError,
    partialRemoved: true,
  });
  return { status: "dead_lettered", entry };
}
