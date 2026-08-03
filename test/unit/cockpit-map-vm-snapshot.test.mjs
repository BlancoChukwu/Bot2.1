/**
 * Unit coverage for cockpit VM snapshot → telemetry mapper.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const mapperPath = join(
  here,
  "..",
  "..",
  "cockpit",
  "src",
  "telemetry",
  "mapVmSnapshotCore.mjs",
);

const { mapVmSnapshot, createEmptyTelemetry } = await import(pathToFileURL(mapperPath).href);

describe("mapVmSnapshot", () => {
  it("maps core live fields from watch-bot-summary JSON", () => {
    const summary = {
      logPath: "logs/event-purity-production-abc.log",
      mode: "live",
      healthy: true,
      wsEventLayerStarted: true,
      window: {
        firstTs: "2026-07-30T12:00:00.000Z",
        lastTs: "2026-07-30T13:00:00.000Z",
        duration: "1h",
      },
      liquidations: {
        candidates: 3,
        firstAttempts: 4,
        sent: 1,
        executed: 1,
        circuitOpen: 0,
        safetyGateBlocked: 0,
      },
      lastRuntimeSnapshot: {
        usersSeeded: 18422,
        positionCacheSize: 9000,
      },
      recentCritical: [],
      recentAttempts: [
        {
          time: "2026-07-30T12:55:00.000Z",
          msg: "liquidation_dry_run_preview",
          account: "0x8f2a91c0deadbeef00112233445566778899aabb",
          simOk: true,
        },
        {
          time: "2026-07-30T12:56:00.000Z",
          msg: "execution_rejected_hf_not_liquidatable",
          account: "0x21bb44e1deadbeef00112233445566778899aabb",
        },
      ],
      recentLifecycle: [
        {
          time: "2026-07-30T12:00:01.000Z",
          msg: "ws_event_layer_started",
        },
      ],
    };

    const telemetry = mapVmSnapshot({
      summaryJson: JSON.stringify(summary),
      healthzJson: JSON.stringify({ ok: true }),
      statusJson: JSON.stringify({ usersSeeded: 18422, bootstrapSource: "cache" }),
      sessionJson: JSON.stringify({
        prefix: "event-purity-production",
        env_file: ".env.event-purity-production",
        simulationMode: false,
        mode: "live",
        enableLiveTx: true,
      }),
      botRunning: true,
      now: new Date("2026-07-30T13:00:00.000Z"),
    });

    expect(telemetry.liveMode).toBe(true);
    expect(telemetry.liveTxEnabled).toBe(true);
    expect(telemetry.botRunning).toBe(true);
    expect(telemetry.circuit).toBe("closed");
    expect(telemetry.seededAccounts).toBe(18422);
    expect(telemetry.liquidatableCount).toBe(3);
    expect(telemetry.liquidationAttempts).toBe(6);
    expect(telemetry.uptimeSec).toBe(3600);
    expect(telemetry.rpcStatus).toBe("up");
    expect(telemetry.versionStamp).toBe("LIVE");
    expect(telemetry.candidates).toEqual([]);
    expect(telemetry.stream.length).toBe(3);
    expect(telemetry.stream.some((e) => e.kind === "ws_event_layer_started")).toBe(true);
    expect(telemetry.stream.some((e) => e.isLiquidation)).toBe(true);
  });

  it("raises critical alerts for safety gate and open circuit", () => {
    const telemetry = mapVmSnapshot({
      summaryJson: JSON.stringify({
        mode: "live",
        healthy: false,
        liquidations: {
          candidates: 0,
          firstAttempts: 0,
          sent: 0,
          executed: 0,
          circuitOpen: 1,
          safetyGateBlocked: 2,
        },
        recentCritical: [
          {
            time: "2026-07-30T12:00:00.000Z",
            msg: "memory_ceiling_hit",
            detail: "RSS soft ceiling",
          },
        ],
        recentAttempts: [],
      }),
      botRunning: false,
    });

    expect(telemetry.circuit).toBe("open");
    expect(telemetry.alerts.some((a) => a.id === "safety-gate")).toBe(true);
    expect(telemetry.alerts.some((a) => a.id === "circuit-open")).toBe(true);
    expect(telemetry.alerts.some((a) => a.title === "memory_ceiling_hit")).toBe(true);
    expect(telemetry.rpcStatus).toBe("degraded");
  });

  it("raises watchlist stale alert when critical count or ageMs is high", () => {
    const telemetry = mapVmSnapshot({
      summaryJson: JSON.stringify({
        mode: "live",
        liquidations: {
          candidates: 0,
          firstAttempts: 0,
          sent: 0,
          executed: 0,
          circuitOpen: 0,
          safetyGateBlocked: 0,
        },
        watchlistStaleness: {
          critical: 5,
          lastAgeMs: 17520030,
          lastAt: "2026-07-31T14:25:15.077Z",
        },
        recentCritical: [],
        recentAttempts: [],
      }),
      botRunning: true,
    });

    expect(telemetry.alerts.some((a) => a.id === "watchlist-stale")).toBe(true);
  });

  it("createEmptyTelemetry returns disconnected defaults", () => {
    const empty = createEmptyTelemetry(new Date("2026-07-30T00:00:00.000Z"));
    expect(empty.botRunning).toBe(false);
    expect(empty.versionStamp).toBe("DISCONNECTED");
    expect(empty.candidates).toEqual([]);
    expect(empty.stream).toEqual([]);
  });

  it("sets liveMode from session meta even when summary.mode is unknown", () => {
    const telemetry = mapVmSnapshot({
      summaryJson: JSON.stringify({
        mode: "unknown",
        liquidations: {
          candidates: 0,
          firstAttempts: 0,
          sent: 0,
          executed: 0,
          circuitOpen: 0,
          safetyGateBlocked: 0,
        },
        recentCritical: [],
        recentAttempts: [],
      }),
      sessionJson: JSON.stringify({
        prefix: "event-purity-production",
        env_file: ".env.event-purity-production",
        log: "logs/event-purity-production-20260730.log",
        simulationMode: false,
        mode: "live",
        enableLiveTx: true,
      }),
      botRunning: true,
    });

    expect(telemetry.liveMode).toBe(true);
    expect(telemetry.liveTxEnabled).toBe(true);
    expect(telemetry.versionStamp).toBe("LIVE");
  });

  it("decouples liveTxEnabled from ENABLE_LIVE_TX session flag", () => {
    const armed = mapVmSnapshot({
      summaryJson: JSON.stringify({ mode: "live", recentAttempts: [], recentLifecycle: [] }),
      sessionJson: JSON.stringify({
        simulationMode: false,
        mode: "live",
        enableLiveTx: true,
        prefix: "event-purity-production",
      }),
      botRunning: true,
    });
    const disarmed = mapVmSnapshot({
      summaryJson: JSON.stringify({ mode: "live", recentAttempts: [], recentLifecycle: [] }),
      sessionJson: JSON.stringify({
        simulationMode: false,
        mode: "live",
        enableLiveTx: false,
        prefix: "event-purity-production",
      }),
      botRunning: true,
    });
    expect(armed.liveMode).toBe(true);
    expect(armed.liveTxEnabled).toBe(true);
    expect(disarmed.liveMode).toBe(true);
    expect(disarmed.liveTxEnabled).toBe(false);
  });

  it("sets liveMode from production log path when mode fields are missing", () => {
    const telemetry = mapVmSnapshot({
      summaryJson: JSON.stringify({
        logPath: "logs/event-purity-production-abc.log",
        liquidations: {
          candidates: 1,
          firstAttempts: 0,
          sent: 0,
          executed: 0,
          circuitOpen: 0,
          safetyGateBlocked: 0,
        },
        recentCritical: [],
        recentAttempts: [],
      }),
      sessionJson: JSON.stringify({}),
      botRunning: true,
    });
    expect(telemetry.liveMode).toBe(true);
  });

  it("tolerates invalid JSON blobs", () => {
    const telemetry = mapVmSnapshot({
      summaryJson: "not-json",
      healthzJson: "{",
      statusJson: undefined,
      botRunning: false,
    });
    expect(telemetry.liveMode).toBe(false);
    expect(telemetry.botRunning).toBe(false);
    expect(telemetry.liquidatableCount).toBe(0);
  });
});
