import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import {
  FIRST_TOUCH_RECONCILE_BACKOFF_MS,
  FIRST_TOUCH_RECONCILE_MAX_ATTEMPTS,
  computeFirstTouchBackoffMs,
  reconcileFirstTouchWithRetry,
  type NeedsManualReconcileEntry,
} from "../../src/monitors/firstTouchReconcile";
import type { ReconcileSeedOutcome } from "../../src/monitors/positionOnChainReconcile";

const account = "0x1111111111111111111111111111111111111111" as Address;

describe("firstTouchReconcile", () => {
  it("computes backoff with ±20% jitter within approved bases", () => {
    expect(computeFirstTouchBackoffMs(0, () => 0)).toBe(Math.round(FIRST_TOUCH_RECONCILE_BACKOFF_MS[0]! * 0.8));
    expect(computeFirstTouchBackoffMs(0, () => 1)).toBe(Math.round(FIRST_TOUCH_RECONCILE_BACKOFF_MS[0]! * 1.2));
    expect(computeFirstTouchBackoffMs(1, () => 0.5)).toBe(FIRST_TOUCH_RECONCILE_BACKOFF_MS[1]);
    expect(computeFirstTouchBackoffMs(2, () => 0.5)).toBe(FIRST_TOUCH_RECONCILE_BACKOFF_MS[2]);
  });

  it("succeeds on first attempt without sleeping", async () => {
    const sleepMs = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deadLetter = new Map<string, NeedsManualReconcileEntry>();
    const removePartialPosition = vi.fn();

    const terminal = await reconcileFirstTouchWithRetry({
      chain: "base",
      account,
      blockNumber: 10n,
      logger,
      needsManualReconcile: deadLetter,
      removePartialPosition,
      attemptReconcile: async (): Promise<ReconcileSeedOutcome> => ({ status: "seeded" }),
      sleepMs,
      random: () => 0.5,
    });

    expect(terminal).toEqual({ status: "seeded" });
    expect(sleepMs).not.toHaveBeenCalled();
    expect(removePartialPosition).not.toHaveBeenCalled();
    expect(deadLetter.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "position_first_touch_reconciled",
      expect.objectContaining({ account, attempt: 1 }),
    );
  });

  it("logs benign skip without retry or dead-letter", async () => {
    const sleepMs = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deadLetter = new Map<string, NeedsManualReconcileEntry>();

    const terminal = await reconcileFirstTouchWithRetry({
      chain: "base",
      account,
      blockNumber: 11n,
      logger,
      needsManualReconcile: deadLetter,
      removePartialPosition: vi.fn(),
      attemptReconcile: async () => ({ status: "benign_skip", reason: "no_debt" }),
      sleepMs,
    });

    expect(terminal).toEqual({ status: "benign_skip", reason: "no_debt" });
    expect(sleepMs).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "position_first_touch_reconcile_skipped_benign",
      expect.objectContaining({ reason: "no_debt" }),
    );
    expect(deadLetter.size).toBe(0);
  });

  it("retries then succeeds: 2 sleeps, no dead-letter", async () => {
    const sleeps: number[] = [];
    const sleepMs = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deadLetter = new Map<string, NeedsManualReconcileEntry>();
    const removePartialPosition = vi.fn();
    let calls = 0;

    const terminal = await reconcileFirstTouchWithRetry({
      chain: "base",
      account,
      blockNumber: 12n,
      logger,
      needsManualReconcile: deadLetter,
      removePartialPosition,
      attemptReconcile: async (): Promise<ReconcileSeedOutcome> => {
        calls += 1;
        if (calls < 3) {
          return { status: "failed", error: `transient_${calls}` };
        }
        return { status: "seeded" };
      },
      sleepMs,
      random: () => 0.5, // no jitter → exact base delays
    });

    expect(terminal).toEqual({ status: "seeded" });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([250, 1_000]);
    expect(removePartialPosition).not.toHaveBeenCalled();
    expect(deadLetter.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "position_first_touch_reconcile_retry",
      expect.objectContaining({ attempt: 1, maxAttempts: 3, error: "transient_1" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "position_first_touch_reconcile_retry",
      expect.objectContaining({ attempt: 2, error: "transient_2" }),
    );
  });

  it("forced persistent failure: 3 attempts, correct backoff, removes live position, populates needsManualReconcile", async () => {
    const sleeps: number[] = [];
    const sleepMs = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deadLetter = new Map<string, NeedsManualReconcileEntry>();
    const removePartialPosition = vi.fn();
    const attemptErrors: string[] = [];
    const nowMs = vi.fn(() => 1_700_000_123_000);

    const terminal = await reconcileFirstTouchWithRetry({
      chain: "base",
      account,
      blockNumber: 48_090_055n,
      logger,
      needsManualReconcile: deadLetter,
      removePartialPosition,
      attemptReconcile: async (): Promise<ReconcileSeedOutcome> => {
        const error = `rpc_boom_${attemptErrors.length + 1}`;
        attemptErrors.push(error);
        return { status: "failed", error };
      },
      sleepMs,
      nowMs,
      random: () => 0.5,
      maxAttempts: FIRST_TOUCH_RECONCILE_MAX_ATTEMPTS,
    });

    expect(attemptErrors).toEqual(["rpc_boom_1", "rpc_boom_2", "rpc_boom_3"]);
    // Attempt 1 immediate; then sleep before 2 and 3 using bases [250, 1000]
    expect(sleeps).toEqual([250, 1_000]);
    expect(removePartialPosition).toHaveBeenCalledTimes(1);

    expect(terminal.status).toBe("dead_lettered");
    if (terminal.status !== "dead_lettered") {
      throw new Error("expected dead_lettered");
    }
    expect(terminal.entry).toEqual({
      reason: "reconcile_failed_after_retries",
      attempts: 3,
      lastError: "rpc_boom_3",
      firstSeenBlock: 48_090_055n,
      lastAttemptAt: 1_700_000_123_000,
    });

    const stored = deadLetter.get(account.toLowerCase());
    expect(stored).toEqual(terminal.entry);

    expect(logger.info).toHaveBeenCalledWith(
      "position_first_touch_reconcile_retry",
      expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "position_first_touch_reconcile_retry",
      expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "position_first_touch_reconcile_retry",
      expect.objectContaining({ attempt: 3, maxAttempts: 3 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "position_first_touch_reconcile_dead_lettered",
      expect.objectContaining({
        account,
        attempts: 3,
        lastError: "rpc_boom_3",
        partialRemoved: true,
        blockNumber: 48_090_055,
      }),
    );
  });
});
