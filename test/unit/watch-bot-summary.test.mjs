/**
 * Unit coverage for watch-bot-summary liquidation counters.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "watch-bot-summary.mjs");

function runSummary(lines, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), "watch-bot-summary-"));
  const logPath = join(dir, "session.log");
  writeFileSync(logPath, lines.map((row) => JSON.stringify(row)).join("\n"), "utf8");
  try {
    const result = spawnSync(process.execPath, [script, logPath, "--json", ...extraArgs], {
      encoding: "utf8",
    });
    expect(result.status === 0 || result.status === 1).toBe(true);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("watch-bot-summary", () => {
  it("counts liquidations and labels soak mode (sent/exec still counted in json)", () => {
    const summary = runSummary([
      { time: "2026-07-26T00:00:00.000Z", msg: "event_purity_liquidatable_candidate", level: 30 },
      { time: "2026-07-26T00:01:00.000Z", msg: "liquidation_evaluated", level: 30, account: "0xabc" },
      { time: "2026-07-26T00:02:00.000Z", msg: "liquidation_dry_run_preview", level: 30, account: "0xabc" },
      { time: "2026-07-26T00:03:00.000Z", msg: "execution_rejected_hf_not_liquidatable", level: 40 },
      { time: "2026-07-26T00:04:00.000Z", msg: "ws_event_layer_started", level: 30 },
    ], ["--mode", "soak"]);

    expect(summary.mode).toBe("soak");
    expect(summary.liquidations.candidates).toBe(1);
    expect(summary.liquidations.evaluated).toBe(1);
    expect(summary.liquidations.dryRuns).toBe(1);
    expect(summary.liquidations.rejected).toBe(1);
    expect(summary.wsEventLayerStarted).toBe(true);
    expect(summary.recentAttempts.length).toBeGreaterThan(0);
  });

  it("marks unhealthy when safety gate is blocked", () => {
    const summary = runSummary([
      {
        time: "2026-07-26T00:00:00.000Z",
        msg: "deployment_safety_gate_blocked",
        level: 50,
        reasons: ["dry_run_expired"],
      },
    ], ["--mode", "live"]);

    expect(summary.mode).toBe("live");
    expect(summary.liquidations.safetyGateBlocked).toBe(1);
    expect(summary.healthy).toBe(false);
  });
});
