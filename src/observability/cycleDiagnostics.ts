import type { LoggerLike } from "../bot";

export interface CycleDiagnosticRow {
  readonly kind: "liquidation" | "arbitrage" | "execution";
  readonly account: string;
  readonly stage: string;
  readonly grossProfitUsd: number;
  readonly gasCostUsd: number;
  readonly netDeltaUsd: number;
  readonly failureMarginBps: number;
  readonly skipReason?: string;
  readonly passed: boolean;
}

export class CycleDiagnosticsCollector {
  private readonly rows: CycleDiagnosticRow[] = [];
  private revenueUsd = 0;
  private evaluations = 0;
  private sims = 0;

  public record(row: CycleDiagnosticRow): void {
    this.rows.push(row);
    this.evaluations += 1;
    if (row.passed) {
      this.revenueUsd += row.netDeltaUsd;
    }
  }

  public recordSim(): void {
    this.sims += 1;
  }

  public snapshot(sent: number, blocksDelta = 1): {
    readonly summary: string;
    readonly rows: readonly CycleDiagnosticRow[];
    readonly revenue_this_cycle: number;
    readonly evaluations: number;
    readonly sims: number;
    readonly sent: number;
    readonly opps_per_block: number;
  } {
    const oppsPerBlock = blocksDelta > 0 ? this.evaluations / blocksDelta : this.evaluations;
    const skipped = this.rows.filter((row) => !row.passed);
    const topReasons = summarizeSkipReasons(skipped);
    const summary = [
      `evaluations=${this.evaluations}`,
      `passed=${this.rows.filter((r) => r.passed).length}`,
      `skipped=${skipped.length}`,
      `revenue_usd=${this.revenueUsd.toFixed(4)}`,
      `sims=${this.sims}`,
      `sent=${sent}`,
      `opps_per_block=${oppsPerBlock.toFixed(2)}`,
      topReasons.length > 0 ? `top_skips=${topReasons.join(";")}` : "top_skips=none",
    ].join(" ");
    return {
      summary,
      rows: [...this.rows],
      revenue_this_cycle: this.revenueUsd,
      evaluations: this.evaluations,
      sims: this.sims,
      sent,
      opps_per_block: oppsPerBlock,
    };
  }

  public emit(logger: LoggerLike, sent: number, blocksDelta = 1): void {
    const payload = this.snapshot(sent, blocksDelta);
    logger.info("pipeline_cycle_diagnostics", payload);
  }

  public reset(): void {
    this.rows.length = 0;
    this.revenueUsd = 0;
    this.evaluations = 0;
    this.sims = 0;
  }
}

function summarizeSkipReasons(rows: readonly CycleDiagnosticRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.skipReason ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${reason}:${count}`);
}

let activeCollector: CycleDiagnosticsCollector | undefined;

export function getCycleDiagnosticsCollector(): CycleDiagnosticsCollector {
  if (activeCollector === undefined) {
    activeCollector = new CycleDiagnosticsCollector();
  }
  return activeCollector;
}

export function resetCycleDiagnosticsCollector(): void {
  activeCollector = undefined;
}
