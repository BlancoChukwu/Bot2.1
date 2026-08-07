import type { OpsSettings } from "../types/telemetry";
import { isTauri } from "../ops/opsClient";
import { Panel } from "./Panel";

interface SettingsPanelProps {
  settings: OpsSettings;
  onChange: (next: OpsSettings) => void;
  disabled?: boolean;
}

async function pickFile(title: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title,
    multiple: false,
    directory: false,
  });
  return typeof selected === "string" ? selected : null;
}

async function pickDirectory(title: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title,
    multiple: false,
    directory: true,
  });
  return typeof selected === "string" ? selected : null;
}

export function SettingsPanel({ settings, onChange, disabled }: SettingsPanelProps) {
  const set = <K extends keyof OpsSettings>(key: K, value: OpsSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  const onBrowseKey = async () => {
    const path = await pickFile("Select SSH private key");
    if (path) set("sshKeyPath", path);
  };

  const onBrowseRepo = async () => {
    const path = await pickDirectory("Select local liquidator repo");
    if (path) set("localRepoPath", path);
  };

  return (
    <Panel title="Connection · local only">
      <div className="grid gap-2 font-mono text-[11px]">
        {(
          [
            ["vmHost", "VM host"],
            ["vmUser", "VM user"],
            ["vmPath", "VM path"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="grid gap-1">
            <span className="text-muted uppercase">{label}</span>
            <input
              value={settings[key]}
              onChange={(e) => set(key, e.target.value)}
              disabled={disabled}
              className="rounded border border-bevel bg-black/40 px-2 py-1.5 text-phosphor outline-none focus:border-phosphor/50 disabled:opacity-50"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        ))}

        <label className="grid gap-1">
          <span className="text-muted uppercase">SSH key path (local)</span>
          <div className="flex gap-2">
            <input
              value={settings.sshKeyPath}
              onChange={(e) => set("sshKeyPath", e.target.value)}
              disabled={disabled}
              className="min-w-0 flex-1 rounded border border-bevel bg-black/40 px-2 py-1.5 text-phosphor outline-none focus:border-phosphor/50 disabled:opacity-50"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={disabled || !isTauri()}
              onClick={() => void onBrowseKey()}
              className="shrink-0 rounded border border-bevel bg-[#1a1a1a] px-2 py-1.5 text-[10px] tracking-wide text-white uppercase hover:brightness-110 disabled:opacity-50"
            >
              Browse
            </button>
          </div>
        </label>

        <label className="grid gap-1">
          <span className="text-muted uppercase">Local repo path</span>
          <div className="flex gap-2">
            <input
              value={settings.localRepoPath}
              onChange={(e) => set("localRepoPath", e.target.value)}
              disabled={disabled}
              className="min-w-0 flex-1 rounded border border-bevel bg-black/40 px-2 py-1.5 text-phosphor outline-none focus:border-phosphor/50 disabled:opacity-50"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={disabled || !isTauri()}
              onClick={() => void onBrowseRepo()}
              className="shrink-0 rounded border border-bevel bg-[#1a1a1a] px-2 py-1.5 text-[10px] tracking-wide text-white uppercase hover:brightness-110 disabled:opacity-50"
            >
              Browse
            </button>
          </div>
        </label>

        <p className="text-[10px] text-muted">
          Secrets stay on disk paths only. Never paste private keys into this UI.
        </p>
      </div>
    </Panel>
  );
}
