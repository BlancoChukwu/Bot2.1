/**
 * Unit coverage for watch-bot --liquidations formatters.
 */
import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  formatEvent,
  formatLogLine,
} from "../../scripts/watchBotLiquidationsFormat.mjs";

describe("watchBotLiquidationsFormat", () => {
  it("drops healthy HF evals by default", () => {
    expect(
      classifyEvent({
        msg: "liquidation_evaluated",
        pass: false,
        nearLiquidation: false,
        skipReason: "healthy_hf_1.20",
        hfFloat: 1.2,
      }),
    ).toBeNull();
  });

  it("keeps floor / near / pass evals", () => {
    expect(
      classifyEvent({
        msg: "liquidation_evaluated",
        pass: false,
        skipReason: "below_effective_floor_30.00",
      }),
    ).toBe("interesting");
    expect(
      classifyEvent({
        msg: "liquidation_evaluated",
        pass: true,
      }),
    ).toBe("interesting");
    expect(
      classifyEvent({
        msg: "liquidation_evaluated",
        nearLiquidation: true,
        pass: false,
      }),
    ).toBe("interesting");
  });

  it("classifies sent and critical tiers", () => {
    expect(classifyEvent({ msg: "transaction_sent", account: "0xabc" })).toBe("sent");
    expect(classifyEvent({ msg: "liquidation_executed" })).toBe("sent");
    expect(classifyEvent({ msg: "candidate_execution_uncaught", level: 50 })).toBe("critical");
    expect(classifyEvent({ msg: "execution_circuit_open", level: 40 })).toBe("fail");
  });

  it("includes healthy evals only with allEvals", () => {
    const row = {
      msg: "liquidation_evaluated",
      pass: false,
      skipReason: "healthy_hf_1.10",
      hfFloat: 1.1,
    };
    expect(classifyEvent(row)).toBeNull();
    expect(classifyEvent(row, { allEvals: true })).toBe("eval");
  });

  it("formats cycle and sent lines without color codes when color=false", () => {
    const cycle = formatEvent(
      {
        time: "2026-07-31T07:13:15.471Z",
        msg: "pipeline_cycle_complete",
        evaluations: 24,
        sent: 1,
        sims: 0,
        failed: 0,
        summary: "evaluations=24 passed=0 skipped=24 top_skips=healthy_hf_1.10:1",
      },
      "cycle",
      { color: false },
    );
    expect(cycle).toContain("pipeline_cycle_complete");
    expect(cycle).toContain("sent=1");
    expect(cycle).toContain("07:13:15");
    expect(cycle).not.toMatch(/\u001b\[/);

    const sent = formatEvent(
      {
        time: "2026-07-31T07:13:15.471Z",
        msg: "transaction_sent",
        account: "0x1234567890abcdef1234567890abcdef12345678",
        txHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
      "sent",
      { color: false },
    );
    expect(sent).toContain("transaction_sent");
    expect(sent).toContain("0x1234…5678");
  });

  it("formatLogLine parses JSON and filters", () => {
    const healthy = formatLogLine(
      JSON.stringify({
        time: "2026-07-31T07:13:15.471Z",
        msg: "liquidation_evaluated",
        account: "0xabc",
        pass: false,
        skipReason: "healthy_hf_1.20",
        hfFloat: 1.2,
      }),
      { color: false },
    );
    expect(healthy).toBeNull();

    const floor = formatLogLine(
      JSON.stringify({
        time: "2026-07-31T07:13:15.471Z",
        msg: "liquidation_evaluated",
        account: "0x0a0904f90730d8ff0ec334ebfbc892d26e757fcc",
        pass: false,
        skipReason: "below_effective_floor_30.00",
        hfFloat: 0.99,
      }),
      { color: false },
    );
    expect(floor).toContain("below_effective_floor_30.00");
    expect(floor).toContain("0x0a09…7fcc");
  });
});
