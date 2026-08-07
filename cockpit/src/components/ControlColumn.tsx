import { useState } from "react";
import type { LogFilter, OpsCommand } from "../types/telemetry";
import { LOG_FILTER_CYCLE } from "../types/telemetry";

interface ControlColumnProps {
  busy: boolean;
  /** When false, ops buttons that talk to the VM are disabled. */
  connected: boolean;
  logFilter: LogFilter;
  onCommand: (command: OpsCommand) => void;
  onStopRequest: () => void;
  onCycleLogFilter: () => void;
}

const CONTROL_CELL =
  "flex min-h-16 w-full flex-col items-center justify-center rounded-xl border-2 px-3 py-3 text-center";

function IndustrialButton({
  labelLines,
  tone,
  disabled,
  onClick,
}: {
  labelLines: string[];
  tone: "amber" | "red" | "steel" | "green";
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneClass = (() => {
    switch (tone) {
      case "amber":
        return "border-[#ffb84d] from-[#5c3a12] to-[#2a1808] shadow-[0_0_18px_rgba(245,165,36,0.45)]";
      case "red":
        return "border-red-glow from-crimson to-[#3a080c] shadow-[0_0_20px_rgba(255,42,42,0.5)]";
      case "green":
        return "border-phosphor/60 from-[#0d3a1c] to-[#07140c] shadow-[0_0_14px_rgba(0,255,65,0.35)]";
      case "steel":
        return "border-bevel from-[#2a2a2a] to-[#1a1a1a]";
      default: {
        const _exhaustive: never = tone;
        return _exhaustive;
      }
    }
  })();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${CONTROL_CELL} cursor-pointer bg-linear-to-b transition-[filter,transform] duration-150 hover:brightness-110 active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-phosphor ${toneClass}`}
    >
      {labelLines.map((line) => (
        <span
          key={line}
          className="block font-display text-sm font-bold tracking-[0.08em] text-white uppercase drop-shadow-[0_0_6px_rgba(255,255,255,0.35)]"
        >
          {line}
        </span>
      ))}
    </button>
  );
}

function logFilterLabel(filter: LogFilter): string {
  switch (filter) {
    case "all":
      return "ALL";
    case "liquidations":
      return "LIQS";
    case "errors":
      return "ERR";
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

export function nextLogFilter(current: LogFilter): LogFilter {
  const idx = LOG_FILTER_CYCLE.indexOf(current);
  return LOG_FILTER_CYCLE[(idx + 1) % LOG_FILTER_CYCLE.length] ?? "all";
}

export function ControlColumn({
  busy,
  connected,
  logFilter,
  onCommand,
  onStopRequest,
  onCycleLogFilter,
}: ControlColumnProps) {
  const [prepareStartClicked, setPrepareStartClicked] = useState(false);
  const [updateCodeClicked, setUpdateCodeClicked] = useState(false);
  const [syncEnvClicked, setSyncEnvClicked] = useState(false);
  const opsDisabled = busy || !connected;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      <IndustrialButton
        labelLines={["PREPARE", "& START", "LIVE"]}
        tone={prepareStartClicked ? "green" : "amber"}
        disabled={opsDisabled}
        onClick={() => {
          setPrepareStartClicked(true);
          onCommand("prepare_and_start_live");
        }}
      />

      <IndustrialButton
        labelLines={["STOP", "BOT"]}
        tone="red"
        disabled={opsDisabled}
        onClick={onStopRequest}
      />

      <IndustrialButton
        labelLines={["UPDATE", "CODE"]}
        tone={updateCodeClicked ? "green" : "amber"}
        disabled={opsDisabled}
        onClick={() => {
          setUpdateCodeClicked(true);
          onCommand("git_pull");
        }}
      />
      <IndustrialButton
        labelLines={["SYNC", "ENV"]}
        tone={syncEnvClicked ? "green" : "amber"}
        disabled={opsDisabled}
        onClick={() => {
          setSyncEnvClicked(true);
          onCommand("sync_env_production");
        }}
      />

      <IndustrialButton
        labelLines={["LOG", logFilterLabel(logFilter)]}
        tone="steel"
        disabled={busy}
        onClick={onCycleLogFilter}
      />
    </div>
  );
}
