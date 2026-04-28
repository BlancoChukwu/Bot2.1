import { describe, expect, it } from "vitest";
import { sendLiquidationAlert } from "../../src/utils/telegramAlert";
import type { LiquidationCandidate } from "../../src/protocols/aaveV3";

const candidate: LiquidationCandidate = {
  account: "0x0000000000000000000000000000000000000001",
  collateralAsset: "0x0000000000000000000000000000000000000002",
  debtAsset: "0x0000000000000000000000000000000000000003",
  debtToCover: 100n,
  repayValueUsd: 1_000,
  liquidationBonusBps: 500,
  healthFactor: 900_000_000_000_000_000n,
};

describe("sendLiquidationAlert", () => {
  it("skips silently when Telegram credentials are missing", async () => {
    let called = false;

    await sendLiquidationAlert({
      token: undefined,
      chatId: undefined,
      candidate,
      mode: "simulated",
      evProfitWei: 10_000_000_000_000_000n,
      fetcher: async () => {
        called = true;
        return { ok: true };
      },
    });

    expect(called).toBe(false);
  });

  it("sends a formatted simulated liquidation alert", async () => {
    const bodies: string[] = [];

    await sendLiquidationAlert({
      token: "token",
      chatId: "chat",
      candidate,
      mode: "simulated",
      evProfitWei: 10_000_000_000_000_000n,
      fetcher: async (_url, init) => {
        bodies.push(String(init?.body));
        return { ok: true };
      },
    });

    expect(bodies[0]).toContain("SIMULATED liquidation");
    expect(bodies[0]).toContain("0.01 ETH");
    expect(bodies[0]).toContain(candidate.account);
  });

  it("includes tx hash when live execution sends a transaction", async () => {
    const bodies: string[] = [];

    await sendLiquidationAlert({
      token: "token",
      chatId: "chat",
      candidate,
      mode: "executed",
      evProfitWei: 10_000_000_000_000_000n,
      txHash: "0xabc",
      fetcher: async (_url, init) => {
        bodies.push(String(init?.body));
        return { ok: true };
      },
    });

    expect(bodies[0]).toContain("EXECUTED liquidation");
    expect(bodies[0]).toContain("0xabc");
  });
});
