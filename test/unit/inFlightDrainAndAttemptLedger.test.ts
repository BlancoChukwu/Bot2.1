import { describe, expect, it } from "vitest";
import { InFlightExecutionRegistry } from "../../src/executors/inFlightExecutionRegistry";
import {
  RecentLiquidationAttemptLedger,
  type RecentAttemptStore,
} from "../../src/executors/recentLiquidationAttemptLedger";

function memoryStore(): RecentAttemptStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
    del: async (key) => {
      data.delete(key);
    },
  };
}

describe("InFlightExecutionRegistry", () => {
  it("drains when in-flight work completes within the bound", async () => {
    const registry = new InFlightExecutionRegistry();
    registry.trackSubmitted("opp-1", "0xabc");
    expect(registry.size()).toBe(1);
    setTimeout(() => registry.complete("opp-1"), 20);
    const result = await registry.waitUntilEmpty(500);
    expect(result.drained).toBe(true);
    expect(result.remaining).toEqual([]);
    expect(registry.size()).toBe(0);
  });

  it("reports remaining ids when drain bound is hit (forced mid-flight)", async () => {
    const registry = new InFlightExecutionRegistry();
    registry.trackSubmitted("opp-kill-mid-flight", "0xdead");
    const result = await registry.waitUntilEmpty(30);
    expect(result.drained).toBe(false);
    expect(result.remaining).toEqual(["opp-kill-mid-flight"]);
    expect(registry.size()).toBe(1);
  });
});

describe("RecentLiquidationAttemptLedger restart idempotency", () => {
  const account = "0x1111111111111111111111111111111111111111" as const;
  const collateral = "0x4200000000000000000000000000000000000006" as const;
  const debt = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

  it("blocks duplicate submit after simulated kill+restart while attempt is submitted", async () => {
    const store = memoryStore();
    const beforeKill = new RecentLiquidationAttemptLedger({ store });
    await beforeKill.recordSubmitted({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
      txHash,
    });

    // Simulate process death + restart: new ledger instance, same durable store.
    const afterRestart = new RecentLiquidationAttemptLedger({ store });
    expect(await afterRestart.isBlocked({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
    })).toBe(true);
  });

  it("clears the block immediately when reconciliation discovers a revert (no TTL wait)", async () => {
    const store = memoryStore();
    const beforeKill = new RecentLiquidationAttemptLedger({ store });
    await beforeKill.recordSubmitted({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
      txHash,
    });

    const afterRestart = new RecentLiquidationAttemptLedger({ store });
    expect(await afterRestart.isBlocked({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
    })).toBe(true);

    const hydrated = await afterRestart.hydrateKey({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
    });
    expect(hydrated?.status).toBe("submitted");

    await afterRestart.reconcile([hydrated!], async () => "reverted");

    expect(await afterRestart.isBlocked({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
    })).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it("keeps the block when reconciliation still sees pending", async () => {
    const store = memoryStore();
    const ledger = new RecentLiquidationAttemptLedger({ store });
    await ledger.recordSubmitted({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
      txHash,
    });
    const entry = await ledger.hydrateKey({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
    });
    await ledger.reconcile([entry!], async () => "pending");
    expect(await ledger.isBlocked({
      chain: "base",
      account,
      collateralAsset: collateral,
      debtAsset: debt,
    })).toBe(true);
  });
});
