import type { LogFilter, StreamEvent } from "../types/telemetry";
import { Panel } from "./Panel";

interface ActivityStreamProps {
  events: StreamEvent[];
  filter: LogFilter;
}

const TONE: Record<StreamEvent["tone"], string> = {
  green: "text-phosphor",
  amber: "text-amber",
  cyan: "text-phosphor-dim",
  red: "text-red-glow",
};

function filterCaption(filter: LogFilter): string {
  switch (filter) {
    case "all":
      return "showing all events";
    case "liquidations":
      return "liquidations only";
    case "errors":
      return "errors only";
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

function matchesFilter(event: StreamEvent, filter: LogFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "liquidations":
      return event.isLiquidation;
    case "errors":
      return event.tone === "red";
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

export function ActivityStream({ events, filter }: ActivityStreamProps) {
  const visible = events.filter((e) => matchesFilter(e, filter));

  return (
    <Panel title="Activity stream · live tail">
      <div className="mb-2 font-mono text-xs tracking-wide text-[#a8b4c2] uppercase">
        Filter · {filterCaption(filter)} · use LOG button to cycle
      </div>
      <div className="max-h-48 overflow-auto rounded-lg border border-bevel/80 bg-black/50 px-3 py-2 font-mono text-sm leading-7">
        {visible.map((ev) => (
          <div key={ev.id} className="whitespace-nowrap">
            <span className="text-muted">{ev.time}</span>{" "}
            <span className={TONE[ev.tone]}>{ev.kind}</span>{" "}
            <span className="text-text/90">{ev.detail}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
