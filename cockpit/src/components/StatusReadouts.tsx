import type { CockpitTelemetry } from "../types/telemetry";
import { Panel } from "./Panel";

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function StatusReadouts({ telemetry }: { telemetry: CockpitTelemetry }) {
  return (
    <div className="grid gap-2">
      <Panel title="Run status">
        <div className="grid grid-cols-2 gap-2 font-mono text-base sm:text-lg">
          <div className="col-span-2">
            Current run time:{" "}
            <span className="text-phosphor">{formatUptime(telemetry.uptimeSec)}</span>
          </div>
          <div className="col-span-2 rounded border border-bevel bg-black/30 px-2 py-1.5">
            Live mode:{" "}
            <span
              className={`font-bold tracking-wide ${
                telemetry.liveMode ? "text-amber" : "text-muted"
              }`}
            >
              {String(telemetry.liveMode)}
            </span>
            <span className="text-muted"> · Live TX: </span>
            <span
              className={`font-bold tracking-wide ${
                telemetry.liveTxEnabled ? "text-amber" : "text-muted"
              }`}
            >
              {String(telemetry.liveTxEnabled)}
            </span>
            <span className="text-muted"> · Stamp: </span>
            <span className={telemetry.versionStamp === "LIVE" ? "text-amber" : "text-muted"}>
              {telemetry.versionStamp}
            </span>
          </div>
          <div>
            Bot:{" "}
            <span className={telemetry.botRunning ? "text-phosphor" : "text-red-glow"}>
              {telemetry.botRunning ? "RUNNING" : "OFF"}
            </span>
          </div>
          <div>
            Circuit: <span className="text-phosphor">{telemetry.circuit.toUpperCase()}</span>
          </div>
          <div>
            Seeded: <span className="text-phosphor">{telemetry.seededAccounts}</span>
          </div>
          <div>
            Liquidatable: <span className="text-phosphor">{telemetry.liquidatableCount}</span>
          </div>
          <div>
            Attempts: <span className="text-phosphor">{telemetry.liquidationAttempts}</span>
          </div>
          <div>
            RPC:{" "}
            <span
              className={
                telemetry.rpcStatus === "up"
                  ? "text-phosphor"
                  : telemetry.rpcStatus === "degraded"
                    ? "text-amber"
                    : "text-red-glow"
              }
            >
              {telemetry.rpcStatus}
            </span>
          </div>
          <div className="col-span-2">
            Residuals: <span className="text-phosphor">{telemetry.residualPositions}</span>
          </div>
          <div className="col-span-2 text-muted">
            Last health: {new Date(telemetry.lastHealthCheckIso).toLocaleTimeString()}
          </div>
        </div>
      </Panel>
    </div>
  );
}
