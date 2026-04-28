import { describe, expect, it } from "vitest";
import { createBotMetrics, LiquidationBot, startMetricsServer } from "../../src/bot";
import type { LiquidationCandidate } from "../../src/protocols/aaveV3";
import { once } from "node:events";

describe("LiquidationBot", () => {
  it("serves a health endpoint for local process supervisors", async () => {
    const server = startMetricsServer(createBotMetrics(), {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }, 0);
    if (server.listening === false) {
      await once(server, "listening");
    }
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected metrics server to bind a local TCP port");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      const body = await response.json() as { status?: string };

      expect(response.ok).toBe(true);
      expect(body.status).toBe("ok");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("continues after a candidate execution fails", async () => {
    const candidates: LiquidationCandidate[] = [
      {
        account: "0x0000000000000000000000000000000000000001",
        collateralAsset: "0x0000000000000000000000000000000000000002",
        debtAsset: "0x0000000000000000000000000000000000000003",
        debtToCover: 100n,
        repayValueUsd: 1_000,
        liquidationBonusBps: 500,
        healthFactor: 900_000_000_000_000_000n,
      },
      {
        account: "0x0000000000000000000000000000000000000004",
        collateralAsset: "0x0000000000000000000000000000000000000005",
        debtAsset: "0x0000000000000000000000000000000000000006",
        debtToCover: 100n,
        repayValueUsd: 1_000,
        liquidationBonusBps: 500,
        healthFactor: 900_000_000_000_000_000n,
      },
    ];
    const executed: string[] = [];

    const bot = new LiquidationBot({
      monitor: { scanOnce: async () => candidates },
      executor: {
        execute: async (candidate) => {
          executed.push(candidate.account);
          if (executed.length === 1) {
            throw new Error("send failed");
          }
          return { status: "sent", txHash: "0xabc", expectedProfitUsd: 10 };
        },
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const summary = await bot.runOnce();

    expect(summary.executed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(executed).toHaveLength(2);
  });

  it("runs polling cycles sequentially until aborted", async () => {
    const controller = new AbortController();
    let activeCycles = 0;
    let maxActiveCycles = 0;
    let cycles = 0;

    const bot = new LiquidationBot({
      monitor: {
        scanOnce: async () => {
          activeCycles += 1;
          maxActiveCycles = Math.max(maxActiveCycles, activeCycles);
          cycles += 1;
          if (cycles === 2) {
            controller.abort();
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeCycles -= 1;
          return [];
        },
      },
      executor: {
        execute: async () => ({ status: "skipped", reason: "none", expectedProfitUsd: 0 }),
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await bot.runPollingLoop({ pollIntervalMs: 400, signal: controller.signal });

    expect(cycles).toBe(2);
    expect(maxActiveCycles).toBe(1);
  });

  it("continues polling after a scan cycle fails", async () => {
    const controller = new AbortController();
    const metrics = LiquidationBot.createMetrics();
    const errors: unknown[] = [];
    let cycles = 0;

    const bot = new LiquidationBot({
      monitor: {
        scanOnce: async () => {
          cycles += 1;
          if (cycles === 1) {
            throw new Error("rpc unavailable");
          }
          controller.abort();
          return [];
        },
      },
      executor: {
        execute: async () => ({ status: "skipped", reason: "none", expectedProfitUsd: 0 }),
      },
      metrics,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (_message, meta) => errors.push(meta),
      },
    });

    await bot.runPollingLoop({ pollIntervalMs: 400, signal: controller.signal });

    expect(cycles).toBe(2);
    expect(errors).toHaveLength(1);
    expect(metrics.snapshot().errorsTotal).toBe(1);
  });

  it("calculates EV in the loop and executes only positions above threshold", async () => {
    const executed: string[] = [];
    const bot = new LiquidationBot({
      monitor: {
        scanOnce: async () => [
          {
            account: "0x0000000000000000000000000000000000000001",
            collateralAsset: "0x0000000000000000000000000000000000000002",
            debtAsset: "0x0000000000000000000000000000000000000003",
            debtToCover: 100n,
            repayValueUsd: 1_000,
            liquidationBonusBps: 500,
            collateralReceivedWei: 1_000_000_000_000_000_000n,
            bonusPercentage: 500,
            gasEstimate: 1_000_000n,
            gasPrice: 1_000_000_000n,
            healthFactor: 900_000_000_000_000_000n,
          },
          {
            account: "0x0000000000000000000000000000000000000004",
            collateralAsset: "0x0000000000000000000000000000000000000005",
            debtAsset: "0x0000000000000000000000000000000000000006",
            debtToCover: 100n,
            repayValueUsd: 1_000,
            liquidationBonusBps: 50,
            collateralReceivedWei: 1_000_000_000_000_000_000n,
            bonusPercentage: 50,
            gasEstimate: 10_000_000n,
            gasPrice: 1_000_000_000n,
            healthFactor: 900_000_000_000_000_000n,
          },
        ],
      },
      executor: {
        execute: async (candidate) => {
          executed.push(candidate.account);
          return { status: "simulated", expectedProfitWei: 1n };
        },
      },
      minProfitWei: 10_000_000_000_000_000n,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const summary = await bot.runOnce();

    expect(summary.executed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(executed).toEqual(["0x0000000000000000000000000000000000000001"]);
  });

  it("records metrics and sends alerts for simulated liquidations", async () => {
    const alerts: string[] = [];
    const metrics = LiquidationBot.createMetrics();
    const bot = new LiquidationBot({
      monitor: {
        scanOnce: async () => [
          {
            account: "0x0000000000000000000000000000000000000001",
            collateralAsset: "0x0000000000000000000000000000000000000002",
            debtAsset: "0x0000000000000000000000000000000000000003",
            debtToCover: 100n,
            repayValueUsd: 1_000,
            liquidationBonusBps: 500,
            collateralReceivedWei: 1_000_000_000_000_000_000n,
            bonusPercentage: 500,
            gasEstimate: 1_000_000n,
            gasPrice: 1_000_000_000n,
            healthFactor: 900_000_000_000_000_000n,
          },
        ],
      },
      executor: {
        execute: async () => ({
          status: "simulated",
          expectedProfitWei: 10_000_000_000_000_000n,
        }),
      },
      minProfitWei: 1n,
      metrics,
      alert: async (event) => {
        alerts.push(event.mode);
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const summary = await bot.runOnce();

    expect(summary.executed).toBe(1);
    expect(alerts).toEqual(["simulated"]);
    expect(metrics.snapshot().positionsScanned).toBe(1);
    expect(metrics.snapshot().liquidationsAttempted).toBe(1);
    expect(metrics.snapshot().liquidationsExecuted).toBe(0);
    expect(metrics.snapshot().totalProfitEth).toBe(0.01);
  });

  it("records scanned account count even when no candidates are liquidatable", async () => {
    const metrics = LiquidationBot.createMetrics();
    const bot = new LiquidationBot({
      monitor: {
        scanOnce: async () => [],
        getLastScanStats: () => ({ scanned: 123, liquidatable: 0 }),
      },
      executor: {
        execute: async () => ({ status: "skipped", reason: "none", expectedProfitUsd: 0 }),
      },
      metrics,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const summary = await bot.runOnce();

    expect(summary.scanned).toBe(123);
    expect(metrics.snapshot().positionsScanned).toBe(123);
  });
});
