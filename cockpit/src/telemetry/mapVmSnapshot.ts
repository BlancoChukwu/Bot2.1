import {
  createEmptyTelemetry as createEmptyTelemetryJs,
  emptyTelemetry as emptyTelemetryJs,
  mapVmSnapshot as mapVmSnapshotJs,
} from "./mapVmSnapshotCore.mjs";
import type { CockpitTelemetry } from "../types/telemetry";

export type MapVmSnapshotInput = {
  summaryJson?: string;
  healthzJson?: string;
  statusJson?: string;
  sessionJson?: string;
  botRunning?: boolean;
  now?: Date;
};

export function mapVmSnapshot(input: MapVmSnapshotInput = {}): CockpitTelemetry {
  return mapVmSnapshotJs(input) as CockpitTelemetry;
}

export function emptyTelemetry(now = new Date()): CockpitTelemetry {
  return emptyTelemetryJs(now) as CockpitTelemetry;
}

export function createEmptyTelemetry(now = new Date()): CockpitTelemetry {
  return createEmptyTelemetryJs(now) as CockpitTelemetry;
}
