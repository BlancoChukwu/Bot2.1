import { useEffect, useState } from "react";
import type {
  CockpitTelemetry,
  DiagnosticAlert,
  LiquidationCandidate,
  StreamEvent,
  WatchedPositionTrace,
} from "../types/telemetry";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function mountainTime(d = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

function utcClock(d = new Date()): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function seedHfTraces(nowSec: number): WatchedPositionTrace[] {
  return [
    {
      id: "t1",
      account: "0x8f2a…91c0",
      points: Array.from({ length: 40 }, (_, i) => ({
        t: nowSec - (39 - i),
        hf: 1.05 + Math.sin(i / 5) * 0.04 - i * 0.001,
      })),
    },
    {
      id: "t2",
      account: "0x21bb…44e1",
      points: Array.from({ length: 40 }, (_, i) => ({
        t: nowSec - (39 - i),
        hf: 1.12 + Math.cos(i / 6) * 0.03,
      })),
    },
    {
      id: "t3",
      account: "0xaa01…77d2",
      points: Array.from({ length: 40 }, (_, i) => ({
        t: nowSec - (39 - i),
        hf: 0.99 + Math.sin(i / 4) * 0.02,
      })),
    },
  ];
}

function seedCandidates(): LiquidationCandidate[] {
  return [
    {
      id: "c1",
      account: "0x8f2a…91c0",
      healthFactor: 0.982,
      projectedProfitUsd: 42.15,
      collateral: "WETH",
      chain: "base",
      debtSymbol: "USDC",
    },
    {
      id: "c2",
      account: "0xaa01…77d2",
      healthFactor: 0.974,
      projectedProfitUsd: 18.4,
      collateral: "cbETH",
      chain: "base",
      debtSymbol: "USDC",
    },
    {
      id: "c3",
      account: "0x21bb…44e1",
      healthFactor: 0.991,
      projectedProfitUsd: 7.2,
      collateral: "wstETH",
      chain: "base",
      debtSymbol: "DAI",
    },
  ];
}

function createInitial(): CockpitTelemetry {
  const now = Math.floor(Date.now() / 1000);
  return {
    liveMode: false,
    liveTxEnabled: false,
    botRunning: true,
    circuit: "closed",
    sessionId: "02",
    versionStamp: "BOT2.2-SOAK",
    uptimeSec: 4 * 3600 + 12 * 60,
    mountainTime: mountainTime(),
    seededAccounts: 18422,
    liquidatableCount: 3,
    liquidationAttempts: 12,
    rpcStatus: "up",
    lastHealthCheckIso: new Date().toISOString(),
    chainsReady: [
      { chain: "base", ready: true },
      { chain: "optimism", ready: false },
    ],
    residualPositions: 2,
    meters: {
      flashLoanSuccessPct: 92,
    },
    candidates: seedCandidates(),
    watchlist: [
      { symbol: "ETH", priceUsd: 3421.2, changePct: 0.8 },
      { symbol: "cbETH", priceUsd: 3580.4, changePct: 0.6 },
      { symbol: "USDC", priceUsd: 1.0, changePct: 0 },
    ],
    hfTraces: seedHfTraces(now),
    alerts: [
      {
        id: "a1",
        severity: "critical",
        title: "memory_warning",
        detail: "RSS approaching soft ceiling — review slope.",
        time: "11:40:08",
        acknowledged: false,
      },
      {
        id: "a2",
        severity: "warning",
        title: "hybrid_detection_failure",
        detail: "Recovered after retry — keep visible until ack.",
        time: "11:22:51",
        acknowledged: false,
      },
    ],
    stream: [
      {
        id: "s1",
        time: "12:04:18",
        tone: "green",
        kind: "dry_run",
        detail: "0x8f2a…91c0 sim ok · est +$4.12",
        isLiquidation: true,
      },
      {
        id: "s2",
        time: "12:01:02",
        tone: "amber",
        kind: "rejected",
        detail: "0x21bb…44e1 hf not liquidatable",
        isLiquidation: true,
      },
      {
        id: "s3",
        time: "11:58:41",
        tone: "cyan",
        kind: "bootstrap",
        detail: "coverage 99.1% · seeded 18422",
        isLiquidation: false,
      },
    ],
    minProfitFloorUsd: 10,
  };
}

/**
 * Laptop-local mock telemetry. No VM I/O.
 * Future: swap adapter for slow SSH-tunneled /status poll (10–30s).
 */
export function useMockTelemetry(tickMs = 1000): CockpitTelemetry {
  const [state, setState] = useState<CockpitTelemetry>(createInitial);

  useEffect(() => {
    const id = window.setInterval(() => {
      setState((prev) => {
        const now = new Date();
        const nowSec = Math.floor(now.getTime() / 1000);
        const meters = {
          flashLoanSuccessPct: Math.max(
            70,
            Math.min(100, prev.meters.flashLoanSuccessPct + (Math.random() - 0.5) * 2),
          ),
        };

        const hfTraces = prev.hfTraces.map((trace) => {
          const last = trace.points[trace.points.length - 1]?.hf ?? 1.05;
          const nextHf = Math.max(0.9, Math.min(1.25, last + (Math.random() - 0.55) * 0.01));
          return {
            ...trace,
            points: [
              ...trace.points.slice(-39),
              { t: nowSec, hf: Number(nextHf.toFixed(4)) },
            ],
          };
        });

        let stream = prev.stream;
        let alerts = prev.alerts;
        let liquidatableCount = prev.liquidatableCount;
        let liquidationAttempts = prev.liquidationAttempts;

        if (Math.random() < 0.2) {
          const roll = Math.random();
          const event: StreamEvent =
            roll < 0.5
              ? {
                  id: `${nowSec}-liq`,
                  time: utcClock(now),
                  tone: "green",
                  kind: "candidate",
                  detail: `HF ${(0.95 + Math.random() * 0.05).toFixed(3)}`,
                  isLiquidation: true,
                }
              : roll < 0.75
                ? {
                    id: `${nowSec}-boot`,
                    time: utcClock(now),
                    tone: "cyan",
                    kind: "bootstrap",
                    detail: "coverage tick · no extra RPC probe",
                    isLiquidation: false,
                  }
                : {
                    id: `${nowSec}-err`,
                    time: utcClock(now),
                    tone: "red",
                    kind: "error",
                    detail: "flash_loan_revert · review diagnostics",
                    isLiquidation: false,
                  };
          stream = [event, ...prev.stream].slice(0, 40);
          if (event.isLiquidation) {
            liquidatableCount += 1;
            liquidationAttempts += 1;
          }
        }

        if (Math.random() < 0.03 && !prev.alerts.some((a) => a.severity === "critical" && !a.acknowledged)) {
          const alert: DiagnosticAlert = {
            id: `crit-${nowSec}`,
            severity: "critical",
            title: "oracle_gap",
            detail: "Price feed gap detected — confirm before live start.",
            time: utcClock(now),
            acknowledged: false,
          };
          alerts = [alert, ...prev.alerts].slice(0, 20);
        }

        return {
          ...prev,
          mountainTime: mountainTime(now),
          uptimeSec: prev.uptimeSec + 1,
          lastHealthCheckIso: now.toISOString(),
          meters,
          hfTraces,
          stream,
          alerts,
          liquidatableCount,
          liquidationAttempts,
          rpcStatus: prev.rpcStatus,
        };
      });
    }, tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);

  return state;
}

export function acknowledgeAlerts(alerts: DiagnosticAlert[]): DiagnosticAlert[] {
  return alerts.map((a) => ({ ...a, acknowledged: true }));
}
