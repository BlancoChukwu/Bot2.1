export type AlertSeverity = "critical" | "warning" | "info";
export type CircuitState = "closed" | "open";
export type LogFilter = "all" | "liquidations" | "errors";

export const LOG_FILTER_CYCLE: LogFilter[] = ["all", "liquidations", "errors"];

export interface LiquidationCandidate {
  id: string;
  account: string;
  healthFactor: number;
  projectedProfitUsd: number;
  collateral: string;
  chain: string;
  debtSymbol: string;
}

export interface WatchlistPrice {
  symbol: string;
  priceUsd: number;
  changePct: number;
}

export interface HfTracePoint {
  t: number;
  hf: number;
}

export interface WatchedPositionTrace {
  id: string;
  account: string;
  points: HfTracePoint[];
}

export interface HealthMeters {
  /** Flash-loan success % for FLASH OK LED (no extra RPC). */
  flashLoanSuccessPct: number;
}

export interface DiagnosticAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  time: string;
  acknowledged: boolean;
}

export interface StreamEvent {
  id: string;
  time: string;
  tone: "green" | "amber" | "cyan" | "red";
  kind: string;
  detail: string;
  isLiquidation: boolean;
}

export interface OpsSettings {
  vmHost: string;
  vmUser: string;
  vmPath: string;
  sshKeyPath: string;
  localRepoPath: string;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  botRunning?: boolean;
  gitHead?: string;
  detail?: string;
  at: string;
}

export interface TelemetrySnapshotResult {
  ok: boolean;
  message: string;
  summaryJson?: string;
  healthzJson?: string;
  statusJson?: string;
  sessionJson?: string;
  botRunning?: boolean;
  detail?: string;
  at: string;
}

export interface CockpitTelemetry {
  liveMode: boolean;
  liveTxEnabled: boolean;
  botRunning: boolean;
  circuit: CircuitState;
  sessionId: string;
  versionStamp: string;
  uptimeSec: number;
  mountainTime: string;
  seededAccounts: number;
  liquidatableCount: number;
  liquidationAttempts: number;
  rpcStatus: "up" | "degraded" | "down";
  lastHealthCheckIso: string;
  chainsReady: Array<{ chain: string; ready: boolean }>;
  residualPositions: number;
  meters: HealthMeters;
  candidates: LiquidationCandidate[];
  watchlist: WatchlistPrice[];
  hfTraces: WatchedPositionTrace[];
  alerts: DiagnosticAlert[];
  stream: StreamEvent[];
  minProfitFloorUsd: number;
}

export type OpsCommand =
  | "prepare_and_start_live"
  | "stop_bot"
  | "git_pull"
  | "sync_env_production";

export interface OpsCommandResult {
  ok: boolean;
  command: OpsCommand;
  message: string;
  detail?: string;
  at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  command: OpsCommand;
  ok: boolean;
  message: string;
}
