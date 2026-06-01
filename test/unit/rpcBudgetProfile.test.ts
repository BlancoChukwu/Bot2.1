import { afterEach, describe, expect, it } from "vitest";
import {
  applyRpcBudgetEnvDefaults,
  gateScaleFactor,
  isRpcBudgetMode,
  scaledGateLimit,
} from "../../src/config/rpcBudgetProfile";

const keysToClear = [
  "RPC_BUDGET_MODE",
  "GATE_SCALE_FACTOR",
  "POLL_INTERVAL_MS",
  "MULTICALL_BATCH_SIZE",
  "GATE_SCALE_FACTOR",
  "COMPETITIVE_GAP_MIN_RATIO",
] as const;

describe("rpcBudgetProfile", () => {
  afterEach(() => {
    for (const key of keysToClear) {
      delete process.env[key];
    }
  });

  it("is off by default", () => {
    expect(isRpcBudgetMode()).toBe(false);
    expect(gateScaleFactor()).toBe(1);
    expect(scaledGateLimit(50)).toBe(50);
  });

  it("doubles gate limits when budget mode is on", () => {
    process.env.RPC_BUDGET_MODE = "true";
    expect(isRpcBudgetMode()).toBe(true);
    expect(gateScaleFactor()).toBe(2);
    expect(scaledGateLimit(50)).toBe(100);
  });

  it("applies poll and batch defaults without overriding explicit env", () => {
    process.env.RPC_BUDGET_MODE = "true";
    process.env.POLL_INTERVAL_MS = "500";
    applyRpcBudgetEnvDefaults();
    expect(process.env.POLL_INTERVAL_MS).toBe("500");
    expect(process.env.MULTICALL_BATCH_SIZE).toBe("125");
    expect(process.env.LOW_TIER_EVERY_BLOCKS).toBe("200");
  });
});
