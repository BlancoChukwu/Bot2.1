import type { BotMetrics, LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";

export type DeploymentGateResult =
  | { readonly status: "allowed" }
  | { readonly status: "blocked"; readonly reasons: readonly string[] };

export interface DeploymentSafetyInput {
  readonly simulationMode: boolean;
  readonly hasMetricsEndpoint: boolean;
  readonly registeredChains: readonly SupportedChain[];
  readonly minProfitMarginBps: number;
  readonly dryRunValidation?: DryRunValidationReceipt;
}

export class DeploymentSafetyGate {
  private readonly dryRunValidationTtlMs: number;

  public constructor(config: { readonly dryRunValidationTtlMs?: number } = {}) {
    this.dryRunValidationTtlMs = config.dryRunValidationTtlMs ?? 15 * 60 * 1_000;
  }

  public evaluate(input: DeploymentSafetyInput): DeploymentGateResult {
    const reasons: string[] = [];
    if (input.registeredChains.length === 0) {
      reasons.push("At least one chain must be registered");
    }
    if (!input.hasMetricsEndpoint) {
      reasons.push("Metrics endpoint is required");
    }
    if (!input.simulationMode && input.minProfitMarginBps < 75) {
      reasons.push("MIN_PROFIT_MARGIN_BPS must be at least 75 in live mode");
    }
    if (input.simulationMode && input.minProfitMarginBps < 40) {
      reasons.push("MIN_PROFIT_MARGIN_BPS must be at least 40 in simulation mode");
    }
    if (!input.simulationMode) {
      reasons.push(...validateDryRunReceipt(input.dryRunValidation, this.dryRunValidationTtlMs));
    }

    return reasons.length === 0 ? { status: "allowed" } : { status: "blocked", reasons };
  }
}

export interface DryRunValidationReceipt {
  readonly success: boolean;
  readonly validatedAtMs: number;
  readonly configHash: string;
  readonly expectedConfigHash: string;
  readonly chains: readonly SupportedChain[];
  readonly expectedChains: readonly SupportedChain[];
}

export interface ConfigHotReloaderConfig<TConfig> {
  readonly initialConfig: TConfig;
  readonly parse: (raw: string) => TConfig;
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
}

export type ConfigReloadResult =
  | { readonly status: "reloaded" }
  | { readonly status: "rejected"; readonly reason: string };

export class ConfigHotReloader<TConfig> {
  private activeConfig: TConfig;

  public constructor(private readonly config: ConfigHotReloaderConfig<TConfig>) {
    this.activeConfig = config.initialConfig;
  }

  public current(): TConfig {
    return this.activeConfig;
  }

  public reload(raw: string): ConfigReloadResult {
    try {
      this.activeConfig = this.config.parse(raw);
      this.config.logger.info("config_hot_reload_applied");
      return { status: "reloaded" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.config.metrics.recordError();
      this.config.logger.warn("config_hot_reload_rejected", { reason });
      return { status: "rejected", reason };
    }
  }
}

export interface GrafanaDashboardDefinition {
  readonly title: string;
  readonly schemaVersion: number;
  readonly panels: readonly GrafanaPanelDefinition[];
}

export interface GrafanaPanelDefinition {
  readonly title: string;
  readonly query: string;
  readonly type: "timeseries" | "stat";
  readonly gridPos: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly targets: readonly [{ readonly expr: string }];
}

export function createGrafanaDashboardDefinition(): GrafanaDashboardDefinition {
  return {
    title: "Aave V3 Liquidation Bot",
    schemaVersion: 39,
    panels: [
      grafanaPanel(1, "Execution Latency", "histogram_quantile(0.95, sum(rate(bot_latency_seconds_bucket{stage=\"execution\"}[5m])) by (le, chain))", "timeseries"),
      grafanaPanel(2, "Scan Latency", "histogram_quantile(0.95, sum(rate(bot_latency_seconds_bucket{stage=\"scan\"}[5m])) by (le, chain))", "timeseries"),
      grafanaPanel(3, "Errors", "sum(rate(errors_total[5m]))", "timeseries"),
      grafanaPanel(4, "Liquidations Executed", "sum(rate(liquidations_executed[5m]))", "stat"),
      grafanaPanel(5, "Profit ETH", "total_profit_eth", "stat"),
    ],
  };
}

export interface PagerDutyAlertDefinition {
  readonly name: string;
  readonly severity: "critical" | "warning";
  readonly expression: string;
  readonly for: string;
  readonly receiver: "pagerduty";
  readonly labels: {
    readonly severity: "critical" | "warning";
    readonly pagerduty: "true";
  };
  readonly annotations: {
    readonly summary: string;
    readonly runbook_url: string;
  };
}

export function createPagerDutyAlertDefinitions(): PagerDutyAlertDefinition[] {
  return [
    {
      name: "ExecutionErrorSpike",
      severity: "critical",
      expression: "sum(rate(errors_total[5m])) > 0.5",
      for: "2m",
      receiver: "pagerduty",
      labels: { severity: "critical", pagerduty: "true" },
      annotations: {
        summary: "Execution errors are spiking",
        runbook_url: "runbooks/execution-error-spike.md",
      },
    },
    {
      name: "NoRecentLiquidations",
      severity: "warning",
      expression: "sum(rate(liquidations_attempted[30m])) == 0",
      for: "30m",
      receiver: "pagerduty",
      labels: { severity: "warning", pagerduty: "true" },
      annotations: {
        summary: "No liquidation attempts in the last 30 minutes",
        runbook_url: "runbooks/no-recent-liquidations.md",
      },
    },
    {
      name: "HighExecutionLatency",
      severity: "warning",
      expression: "histogram_quantile(0.95, sum(rate(bot_latency_seconds_bucket{stage=\"execution\"}[5m])) by (le)) > 2",
      for: "5m",
      receiver: "pagerduty",
      labels: { severity: "warning", pagerduty: "true" },
      annotations: {
        summary: "P95 execution latency is above 2 seconds",
        runbook_url: "runbooks/high-execution-latency.md",
      },
    },
  ];
}

export interface ShutdownResult {
  readonly status: "completed" | "completed_with_errors" | "already_completed";
  readonly errors: readonly string[];
}

export interface GracefulShutdownCoordinatorConfig {
  readonly logger: LoggerLike;
  readonly metrics: BotMetrics;
  readonly timeoutMs: number;
}

export class GracefulShutdownCoordinator {
  private readonly hooks: Array<{ readonly name: string; readonly run: () => Promise<void> }> = [];
  private completed = false;
  private inFlight: Promise<ShutdownResult> | undefined;

  public constructor(private readonly config: GracefulShutdownCoordinatorConfig) {}

  public addHook(name: string, run: () => Promise<void>): void {
    this.hooks.push({ name, run });
  }

  public async shutdown(signal: string): Promise<ShutdownResult> {
    if (this.completed) {
      return { status: "already_completed", errors: [] };
    }
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    this.inFlight = this.runShutdown(signal);
    return this.inFlight;
  }

  private async runShutdown(signal: string): Promise<ShutdownResult> {
    this.config.logger.info("graceful_shutdown_started", { signal });
    const errors: string[] = [];

    for (const hook of this.hooks) {
      const error = await runWithTimeout(hook.name, hook.run, this.config.timeoutMs);
      if (error !== undefined) {
        errors.push(error);
        this.config.metrics.recordError();
        this.config.logger.error("graceful_shutdown_hook_failed", { hook: hook.name, error });
      }
    }

    this.completed = true;
    const result = {
      status: errors.length === 0 ? "completed" : "completed_with_errors",
      errors,
    } satisfies ShutdownResult;
    this.inFlight = undefined;
    return result;
  }
}

function validateDryRunReceipt(
  receipt: DryRunValidationReceipt | undefined,
  ttlMs: number,
): string[] {
  if (receipt === undefined) {
    return ["Successful dry-run validation is required before live mode"];
  }
  const reasons: string[] = [];
  if (!receipt.success) {
    reasons.push("Dry-run validation must be successful");
  }
  if (!Number.isFinite(receipt.validatedAtMs)) {
    reasons.push("Dry-run validation timestamp is invalid");
    return reasons;
  }
  if (receipt.validatedAtMs - Date.now() > 60_000) {
    reasons.push("Dry-run validation timestamp is in the future");
  }
  if (Date.now() - receipt.validatedAtMs > ttlMs) {
    reasons.push("Dry-run validation is stale");
  }
  if (receipt.configHash !== receipt.expectedConfigHash) {
    reasons.push("Dry-run validation config hash does not match current config");
  }
  if (receipt.chains.join(",") !== receipt.expectedChains.join(",")) {
    reasons.push("Dry-run validation chains do not match current chains");
  }
  return reasons;
}

function grafanaPanel(
  id: number,
  title: string,
  query: string,
  type: "timeseries" | "stat",
): GrafanaPanelDefinition {
  return {
    id,
    title,
    query,
    type,
    gridPos: { x: ((id - 1) % 2) * 12, y: Math.floor((id - 1) / 2) * 8, w: 12, h: 8 },
    targets: [{ expr: query }],
  } as GrafanaPanelDefinition & { readonly id: number };
}

async function runWithTimeout(
  name: string,
  run: () => Promise<void>,
  timeoutMs: number,
): Promise<string | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${name} timed out`)), timeoutMs);
      }),
    ]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
