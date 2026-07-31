import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Force an immediate SSH snapshot (e.g. after Prepare & Start Live). */
  refreshNow: () => Promise<void>;
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
  const connectedRef = useRef(connected);
  settingsRef.current = settings;
  connectedRef.current = connected;

  const applySnapshot = useCallback(async () => {
    if (!connectedRef.current || inFlight.current) return;
    inFlight.current = true;
    setPolling(true);
    try {
      const snap = await fetchTelemetrySnapshot(settingsRef.current);
      if (!snap.ok) {
        setLastError(snap.message);
        return;
      }
      const mapped = mapVmSnapshot({
        summaryJson: snap.summaryJson,
        healthzJson: snap.healthzJson,
        statusJson: snap.statusJson,
        sessionJson: snap.sessionJson,
        botRunning: snap.botRunning,
      });
      setTelemetry((prev) => ({
        ...mapped,
        alerts: mapped.alerts.map((a) => {
          const prior = prev.alerts.find((p) => p.id === a.id);
          return prior?.acknowledged ? { ...a, acknowledged: true } : a;
        }),
      }));
      setLastPollIso(new Date().toISOString());
      setLastError(null);
    } catch (error) {
      setLastError(String(error));
    } finally {
      inFlight.current = false;
      setPolling(false);
    }
  }, []);

  const refreshNow = useCallback(async () => {
    await applySnapshot();
  }, [applySnapshot]);

  useEffect(() => {
    if (!connected) {
      setTelemetry(emptyTelemetry());
      setLastPollIso(null);
      setLastError(null);
      setPolling(false);
      return;
    }

    let cancelled = false;

    const tick = async () => {
      if (cancelled || paused) return;
      await applySnapshot();
    };

    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, pollMs);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [applySnapshot, connected, paused, pollMs, settings.vmHost, settings.vmUser, settings.vmPath, settings.sshKeyPath]);

  return { telemetry, lastPollIso, lastError, polling, refreshNow };
}
