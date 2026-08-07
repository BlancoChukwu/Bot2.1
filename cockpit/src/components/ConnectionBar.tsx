import type { ConnectionState } from "../types/telemetry";

interface ConnectionBarProps {
  state: ConnectionState;
  busy: boolean;
  lastPollIso: string | null;
  lastError: string | null;
  polling: boolean;
  gitHead?: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

function stateLabel(state: ConnectionState): string {
  switch (state) {
    case "disconnected":
      return "VM: offline";
    case "connecting":
      return "VM: connecting…";
    case "connected":
      return "VM: connected";
    case "error":
      return "VM: error";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function stateClass(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "text-phosphor";
    case "connecting":
      return "text-amber";
    case "error":
      return "text-red-glow";
    case "disconnected":
      return "text-muted";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function ConnectionBar({
  state,
  busy,
  lastPollIso,
  lastError,
  polling,
  gitHead,
  onConnect,
  onDisconnect,
}: ConnectionBarProps) {
  const connected = state === "connected";

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-bevel bg-panel px-3 py-2 font-mono text-xs">
      <span className={`font-bold tracking-wide uppercase ${stateClass(state)}`}>
        {stateLabel(state)}
      </span>
      {gitHead ? <span className="text-muted">git {gitHead}</span> : null}
      {lastPollIso ? (
        <span className="text-muted">
          last poll {new Date(lastPollIso).toLocaleTimeString()}
          {polling ? " · refreshing…" : ""}
        </span>
      ) : (
        <span className="text-muted">no poll yet</span>
      )}
      {lastError ? (
        <span className="max-w-md truncate text-red-glow" title={lastError}>
          {lastError}
        </span>
      ) : null}
      <div className="ml-auto flex gap-2">
        {connected ? (
          <button
            type="button"
            disabled={busy}
            onClick={onDisconnect}
            className="rounded border border-bevel bg-[#1a1a1a] px-3 py-1.5 text-[10px] font-bold tracking-[0.12em] text-white uppercase hover:brightness-110 disabled:opacity-50"
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || state === "connecting"}
            onClick={onConnect}
            className="rounded border border-phosphor/60 bg-[#0d3a1c] px-3 py-1.5 text-[10px] font-bold tracking-[0.12em] text-phosphor uppercase shadow-[0_0_12px_rgba(0,255,65,0.25)] hover:brightness-110 disabled:opacity-50"
          >
            {state === "connecting" ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    </div>
  );
}
