import { useEffect, useRef, useState } from "react";
import { fetchTelemetrySnapshot } from "../ops/opsClient";
import type { CockpitTelemetry, OpsSettings } from "../types/telemetry";
import { emptyTelemetry, mapVmSnapshot } from "./mapVmSnapshot";

const POLL_MS = 20_000;

export interface UseVmTelemetryOptions {
  connected: boolean;
  settings: OpsSettings;
  /** Pause polls while an ops command is in flight. */
  paused?: boolean;
  pollMs?: number;
}

export interface VmTelemetryState {
  telemetry: CockpitTelemetry;
  lastPollIso: string | null;
  lastError: string | null;
  polling: boolean;
}

/**
 * Slow SSH telemetry poll (default 20s). No-op when disconnected.
 * Never contacts the bot hot path — only allowlisted SSH reads.
 */
export function useVmTelemetry({
  connected,
  settings,
  paused = false,
  pollMs = POLL_MS,
}: UseVmTelemetryOptions): VmTelemetryState {
  const [telemetry, setTelemetry] = useState<CockpitTelemetry>(() => emptyTelemetry());
  const [lastPollIso, setLastPollIso] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const inFlight = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (!connected) {
      setTelemetry(emptyTelemetry());
      setLastPollIso(null);
      setLastError(null);
      setPolling(false);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      if (cancelled || paused || inFlight.current) return;
      inFlight.current = true;
      setPolling(true);
      try {
        const snap = await fetchTelemetrySnapshot(settingsRef.current);
        if (cancelled) return;
        if (!snap.ok) {
          setLastError(snap.message);
          return;
        }
        const mapped = mapVmSnapshot({
          summaryJson: snap.summaryJson,
          healthzJson: snap.healthzJson,
          statusJson: snap.statusJson,
          botRunning: snap.botRunning,
        });
        setTelemetry((prev) => ({
          ...mapped,
          // Preserve acknowledged alerts across polls when ids match.
          alerts: mapped.alerts.map((a) => {
            const prior = prev.alerts.find((p) => p.id === a.id);
            return prior?.acknowledged ? { ...a, acknowledged: true } : a;
          }),
        }));
        setLastPollIso(new Date().toISOString());
        setLastError(null);
      } catch (error) {
        if (!cancelled) setLastError(String(error));
      } finally {
        inFlight.current = false;
        if (!cancelled) setPolling(false);
      }
    };

    void poll();
    const id = window.setInterval(() => {
      void poll();
    }, pollMs);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connected, paused, pollMs, settings.vmHost, settings.vmUser, settings.vmPath, settings.sshKeyPath]);

  return { telemetry, lastPollIso, lastError, polling };
}
