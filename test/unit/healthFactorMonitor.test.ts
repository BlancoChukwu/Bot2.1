import { describe, expect, it } from "vitest";
import { HealthFactorMonitor } from "../../src/monitors/healthFactorMonitor";
import type { AaveV3Protocol } from "../../src/protocols/aaveV3";

const account = "0x0000000000000000000000000000000000000001";
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("HealthFactorMonitor", () => {
  it("returns only broad-market candidates that are liquidatable and profitable", async () => {
    const protocol: AaveV3Protocol = {
      getLiquidatablePositions: async () => [
        {
          account,
          collateralAsset: "0x0000000000000000000000000000000000000002",
          debtAsset: "0x0000000000000000000000000000000000000003",
          debtToCover: 100n,
          repayValueUsd: 1_000,
          liquidationBonusBps: 500,
          healthFactor: 950_000_000_000_000_000n,
        },
        {
          account: "0x0000000000000000000000000000000000000004",
          collateralAsset: "0x0000000000000000000000000000000000000002",
          debtAsset: "0x0000000000000000000000000000000000000003",
          debtToCover: 100n,
          repayValueUsd: 10,
          liquidationBonusBps: 500,
          healthFactor: 900_000_000_000_000_000n,
        },
      ],
    };

    const monitor = new HealthFactorMonitor({
      protocol,
      pollIntervalMs: 400,
      candidateCooldownMs: 1_000,
      minProfitUsd: 10,
      gasCostUsd: 4,
      slippageBps: 50,
      logger,
    });

    const candidates = await monitor.scanOnce();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.account).toBe(account);
  });

  it("deduplicates candidates during the cooldown window", async () => {
    const protocol: AaveV3Protocol = {
      getLiquidatablePositions: async () => [
        {
          account,
          collateralAsset: "0x0000000000000000000000000000000000000002",
          debtAsset: "0x0000000000000000000000000000000000000003",
          debtToCover: 100n,
          repayValueUsd: 1_000,
          liquidationBonusBps: 500,
          healthFactor: 900_000_000_000_000_000n,
        },
      ],
    };

    const monitor = new HealthFactorMonitor({
      protocol,
      pollIntervalMs: 400,
      candidateCooldownMs: 60_000,
      minProfitUsd: 10,
      gasCostUsd: 4,
      slippageBps: 50,
      logger,
    });

    expect(await monitor.scanOnce()).toHaveLength(1);
    expect(await monitor.scanOnce()).toHaveLength(0);
  });

  it("logs each scan with scanned and liquidatable counts", async () => {
    const messages: unknown[] = [];
    const protocol: AaveV3Protocol = {
      getLiquidatablePositions: async () => [
        {
          account,
          collateralAsset: "0x0000000000000000000000000000000000000002",
          debtAsset: "0x0000000000000000000000000000000000000003",
          debtToCover: 100n,
          repayValueUsd: 1_000,
          liquidationBonusBps: 500,
          healthFactor: 900_000_000_000_000_000n,
        },
      ],
    };
    const monitor = new HealthFactorMonitor({
      protocol,
      pollIntervalMs: 400,
      candidateCooldownMs: 0,
      minProfitUsd: 10,
      gasCostUsd: 4,
      slippageBps: 50,
      logger: {
        ...logger,
        info: (_message, meta) => messages.push(meta),
      },
    });

    await monitor.scanOnce();

    expect(messages).toContainEqual({ scanned: 1, liquidatable: 1 });
  });

  it("accepts configurable polling cadence for adaptive backpressure", () => {
    const protocol: AaveV3Protocol = {
      getLiquidatablePositions: async () => [],
    };

    expect(() =>
      new HealthFactorMonitor({
        protocol,
        pollIntervalMs: 401,
        candidateCooldownMs: 0,
        minProfitUsd: 10,
        gasCostUsd: 4,
        slippageBps: 50,
        logger,
      }),
    ).not.toThrow();
  });

  it("starts and stops ReserveDataUpdated subscriptions when supported", async () => {
    const calls: string[] = [];
    const protocol: AaveV3Protocol = {
      getLiquidatablePositions: async () => [],
      subscribeToReserveDataUpdated: async () => {
        calls.push("subscribe");
        return () => calls.push("unsubscribe");
      },
    };
    const monitor = new HealthFactorMonitor({
      protocol,
      pollIntervalMs: 400,
      candidateCooldownMs: 0,
      minProfitUsd: 10,
      gasCostUsd: 4,
      slippageBps: 50,
      logger,
    });

    await monitor.startReserveDataUpdatedSubscription();
    monitor.stopReserveDataUpdatedSubscription();

    expect(calls).toEqual(["subscribe", "unsubscribe"]);
  });
});
