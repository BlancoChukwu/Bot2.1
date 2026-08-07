import { useEffect, useState } from "react";
import { ActivityStream } from "./components/ActivityStream";
import { CandidatesTable } from "./components/CandidatesTable";
import { ConfirmModal } from "./components/ConfirmModal";
import { ConnectionBar } from "./components/ConnectionBar";
import { ControlColumn, nextLogFilter } from "./components/ControlColumn";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusReadouts } from "./components/StatusReadouts";
import { acknowledgeAlerts, useMockTelemetry } from "./mock/useMockTelemetry";
import {
  isTauri,
  loadLogFilter,
  loadSettings,
  runOpsCommand,
  saveLogFilter,
  saveSettings,
  testVmConnection,
} from "./ops/opsClient";
import { emptyTelemetry } from "./telemetry/mapVmSnapshot";
import { useVmTelemetry } from "./telemetry/useVmTelemetry";
import type {
  ConnectionState,
  DiagnosticAlert,
  LogFilter,
  OpsCommand,
  OpsSettings,
} from "./types/telemetry";

export default function App() {
  const desktop = isTauri();
  const mockTelemetry = useMockTelemetry(1000);
  const [settings, setSettings] = useState<OpsSettings>(loadSettings);
  const [logFilter, setLogFilter] = useState<LogFilter>(loadLogFilter);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [gitHead, setGitHead] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connected = connectionState === "connected";
  const vm = useVmTelemetry({
    connected: desktop && connected,
    settings,
    paused: busy,
  });

  const telemetry = desktop
    ? connected
      ? vm.telemetry
      : emptyTelemetry()
    : mockTelemetry;

  const [alerts, setAlerts] = useState<DiagnosticAlert[]>(telemetry.alerts);

  useEffect(() => {
    setAlerts((prev) => {
      const known = new Map(prev.map((a) => [a.id, a]));
      const merged = telemetry.alerts.map((a) => {
        const prior = known.get(a.id);
        return prior?.acknowledged ? { ...a, acknowledged: true } : a;
      });
      // Keep previously acknowledged alerts that disappeared briefly.
      for (const prior of prev) {
        if (prior.acknowledged && !merged.some((a) => a.id === prior.id)) {
          merged.push(prior);
        }
      }
      return merged.slice(0, 20);
    });
  }, [telemetry.alerts]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4200);
  };

  const onSettingsChange = (next: OpsSettings) => {
    setSettings(next);
    saveSettings(next);
  };

  const onCycleLogFilter = () => {
    const next = nextLogFilter(logFilter);
    setLogFilter(next);
    saveLogFilter(next);
  };

  const onConnect = async () => {
    if (!desktop) {
      showToast("Connect requires desktop app — run scripts/start-cockpit.ps1");
      setConnectionState("error");
      setConnectError("Vite preview cannot SSH. Use start-cockpit.ps1 / tauri:dev.");
      return;
    }
    if (!settings.sshKeyPath.trim()) {
      setConnectionState("error");
      setConnectError("SSH key path is required");
      showToast("SSH key path is required");
      return;
    }
    setConnectionState("connecting");
    setConnectError(null);
    setBusy(true);
    try {
      saveSettings(settings);
      const result = await testVmConnection(settings);
      if (!result.ok) {
        setConnectionState("error");
        setConnectError(result.message);
        showToast(result.message);
        return;
      }
      setGitHead(result.gitHead ?? null);
      setConnectionState("connected");
      showToast(result.message);
    } catch (error) {
      const msg = String(error);
      setConnectionState("error");
      setConnectError(msg);
      showToast(`Connect failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = () => {
    setConnectionState("disconnected");
    setGitHead(null);
    setConnectError(null);
    showToast("Disconnected from VM");
  };

  const onCommand = async (command: OpsCommand) => {
    if (!connected && desktop) {
      showToast("Connect to the VM before running ops commands");
      return;
    }
    setBusy(true);
    let ok = false;
    try {
      const result = await runOpsCommand(command, settings);
      ok = result.ok;
      showToast(result.message);
      // After lifecycle ops, refresh immediately so Live mode / RUNNING update.
      if (
        ok &&
        (command === "prepare_and_start_live" ||
          command === "stop_bot" ||
          command === "sync_env_production")
      ) {
        await vm.refreshNow();
      }
    } catch (error) {
      showToast(`Command failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }

    // Background confirmation polls — do not keep controls locked.
    if (ok && command === "prepare_and_start_live" && connected) {
      void (async () => {
        const delaysMs = [3_000, 8_000, 15_000, 30_000, 45_000];
        for (const delay of delaysMs) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, delay);
          });
          const snap = await vm.refreshNow();
          if (snap?.liveMode && snap.botRunning) {
            showToast(
              `Live confirmed — mode=${String(snap.liveMode)} tx=${String(snap.liveTxEnabled)}`,
            );
            return;
          }
        }
        showToast("Bot started — Live mode still pending; check Run status / Activity stream");
      })();
    }
  };

  const statusAlerts = alerts;
  const streamError = connectError ?? vm.lastError;

  return (
    <div className="relative mx-auto max-w-[1480px] px-3 py-4 sm:px-5">
      <div className="mb-3 grid gap-3 lg:grid-cols-[1.1fr_1fr]">
        <SettingsPanel
          settings={settings}
          onChange={onSettingsChange}
          disabled={busy || connectionState === "connecting"}
        />
        <div className="grid gap-3 self-start">
          <ConnectionBar
            state={connectionState}
            busy={busy}
            lastPollIso={vm.lastPollIso}
            lastError={streamError}
            polling={vm.polling}
            gitHead={gitHead}
            onConnect={() => void onConnect()}
            onDisconnect={onDisconnect}
          />
          {!desktop ? (
            <p className="font-mono text-[11px] text-amber">
              Browser preview uses mock telemetry. Launch the desktop app for real VM
              control.
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.12fr_1fr]">
        <div className="grid gap-3 self-start">
          <DiagnosticsPanel
            alerts={statusAlerts}
            onAcknowledge={() => setAlerts(acknowledgeAlerts(statusAlerts))}
          />
          <ActivityStream events={telemetry.stream} filter={logFilter} />
        </div>

        <div className="grid gap-3 self-start">
          <StatusReadouts telemetry={telemetry} />
          <CandidatesTable
            candidates={telemetry.candidates}
            minProfitFloorUsd={telemetry.minProfitFloorUsd}
          />
        </div>
      </div>

      <div className="mt-3">
        <ControlColumn
          busy={busy}
          connected={!desktop || connected}
          logFilter={logFilter}
          onCommand={onCommand}
          onStopRequest={() => setStopOpen(true)}
          onCycleLogFilter={onCycleLogFilter}
        />
        <p className="mt-2 font-mono text-[10px] tracking-wide text-muted uppercase">
          Controls: Prepare / Stop / Update / Sync / Log -- live mode is Run status only
        </p>
      </div>

      {toast ? (
        <div className="fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border border-bevel bg-panel px-3 py-2 font-mono text-xs text-phosphor shadow-xl">
          {toast}
        </div>
      ) : null}

      <ConfirmModal
        open={stopOpen}
        title="STOP BOT"
        body="Stop the liquidator process on the Oracle VM via allowlisted SSH command?"
        confirmLabel="STOP BOT"
        onCancel={() => setStopOpen(false)}
        onConfirm={() => {
          setStopOpen(false);
          void onCommand("stop_bot");
        }}
      />
    </div>
  );
}
