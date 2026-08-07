import type {
  AuditEntry,
  ConnectionTestResult,
  LogFilter,
  OpsCommand,
  OpsCommandResult,
  OpsSettings,
  TelemetrySnapshotResult,
} from "../types/telemetry";

const SETTINGS_KEY = "liquidator-cockpit-ops-settings";
const AUDIT_KEY = "liquidator-cockpit-audit";
const LOG_FILTER_KEY = "liquidator-cockpit-log-filter";

export const DEFAULT_SETTINGS: OpsSettings = {
  vmHost: "143.47.121.38",
  vmUser: "ubuntu",
  vmPath: "/home/ubuntu/liquidator",
  sshKeyPath: String.raw`C:\Users\brick\Downloads\ssh-key-2026-05-29 (1).key`,
  localRepoPath: String.raw`e:\Mini PC\optimism-aave-v3-liquidator-ts`,
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function loadSettings(): OpsSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: OpsSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadLogFilter(): LogFilter {
  const v = localStorage.getItem(LOG_FILTER_KEY);
  if (v === "liquidations" || v === "errors") return v;
  return "all";
}

export function saveLogFilter(filter: LogFilter): void {
  localStorage.setItem(LOG_FILTER_KEY, filter);
}

export function loadAudit(): AuditEntry[] {
  try {
    const raw = localStorage.getItem(AUDIT_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AuditEntry[];
  } catch {
    return [];
  }
}

function pushAudit(entry: AuditEntry): void {
  const next = [entry, ...loadAudit()].slice(0, 100);
  localStorage.setItem(AUDIT_KEY, JSON.stringify(next));
}

async function invokeTauriCommand(
  command: OpsCommand,
  settings: OpsSettings,
): Promise<OpsCommandResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<OpsCommandResult>("run_ops_command", { command, settings });
}

/** Browser preview fallback — never talks to the VM. */
function mockOpsCommand(command: OpsCommand): OpsCommandResult {
  return {
    ok: true,
    command,
    message: `Simulated ${command} (Vite preview — use tauri:dev for real SSH)`,
    at: new Date().toISOString(),
  };
}

export async function runOpsCommand(
  command: OpsCommand,
  settings: OpsSettings,
): Promise<OpsCommandResult> {
  const result = isTauri()
    ? await invokeTauriCommand(command, settings)
    : mockOpsCommand(command);

  const message = result.detail
    ? `${result.message}: ${result.detail.slice(0, 240)}`
    : result.message;

  pushAudit({
    id: `${Date.now()}`,
    at: result.at,
    command: result.command,
    ok: result.ok,
    message,
  });

  return { ...result, message };
}

export async function testVmConnection(
  settings: OpsSettings,
): Promise<ConnectionTestResult> {
  if (!isTauri()) {
    return {
      ok: false,
      message: "Connect requires the desktop app (npm run tauri:dev / start-cockpit.ps1)",
      at: new Date().toISOString(),
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ConnectionTestResult>("test_vm_connection", { settings });
}

export async function fetchTelemetrySnapshot(
  settings: OpsSettings,
): Promise<TelemetrySnapshotResult> {
  if (!isTauri()) {
    return {
      ok: false,
      message: "Telemetry poll requires the desktop app",
      at: new Date().toISOString(),
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<TelemetrySnapshotResult>("fetch_telemetry_snapshot", { settings });
}
