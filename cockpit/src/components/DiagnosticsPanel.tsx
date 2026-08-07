import type { AlertSeverity, DiagnosticAlert } from "../types/telemetry";
import { Panel } from "./Panel";

interface DiagnosticsProps {
  alerts: DiagnosticAlert[];
  onAcknowledge: () => void;
}

function severityTone(severity: AlertSeverity, acknowledged: boolean): string {
  switch (severity) {
    case "critical":
      return acknowledged ? "text-muted" : "text-red-glow";
    case "warning":
      return "text-amber";
    case "info":
      return "text-phosphor";
    default: {
      const _exhaustive: never = severity;
      return _exhaustive;
    }
  }
}

export function DiagnosticsPanel({ alerts, onAcknowledge }: DiagnosticsProps) {
  const hasCritical = alerts.some((a) => a.severity === "critical" && !a.acknowledged);

  return (
    <Panel title="Diagnostics · alerts">
      <div className="mb-2 flex items-center justify-between">
        <span
          className={`font-mono text-xs uppercase ${
            hasCritical ? "text-red-glow" : "text-muted"
          }`}
        >
          {hasCritical ? "CRITICAL ACTIVE" : "NO UNACK CRITICAL"}
        </span>
        <button
          type="button"
          onClick={onAcknowledge}
          className="font-mono text-xs text-phosphor uppercase hover:underline"
        >
          Acknowledge
        </button>
      </div>
      <div className="grid max-h-56 gap-2 overflow-auto">
        {alerts.length === 0 ? (
          <p className="font-mono text-sm text-muted">No alerts</p>
        ) : (
          alerts.map((alert) => {
            const unackedCritical =
              alert.severity === "critical" && !alert.acknowledged;
            const tone = severityTone(alert.severity, alert.acknowledged);

            return (
              <article
                key={alert.id}
                className="rounded-lg border border-bevel bg-black/20 px-3 py-2.5"
              >
                <div className="flex justify-between font-mono text-xs text-muted">
                  <span className={`font-bold uppercase ${tone}`}>
                    {alert.severity}
                  </span>
                  <span>{alert.time}</span>
                </div>
                <div
                  className={`mt-1 font-display text-base font-semibold ${tone} ${
                    unackedCritical ? "flash-critical" : ""
                  }`}
                >
                  {alert.title}
                </div>
                <div className={`mt-0.5 font-mono text-sm ${tone}`}>{alert.detail}</div>
              </article>
            );
          })
        )}
      </div>
    </Panel>
  );
}
