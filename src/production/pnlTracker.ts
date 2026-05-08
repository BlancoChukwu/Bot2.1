import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export interface PnlSnapshot {
  readonly timestampIso: string;
  readonly netProfitUsd: number;
  readonly arbitrageExecuted: number;
  readonly liquidationsExecuted: number;
}

export class PnlTracker {
  public constructor(private readonly csvPath: string) {
    ensureCsv(csvPath);
  }

  public append(snapshot: PnlSnapshot): void {
    appendFileSync(
      this.csvPath,
      `${snapshot.timestampIso},${snapshot.netProfitUsd.toFixed(2)},${snapshot.arbitrageExecuted},${snapshot.liquidationsExecuted}\n`,
      "utf8",
    );
  }
}

function ensureCsv(path: string): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "timestamp_iso,net_profit_usd,arbitrage_executed,liquidations_executed\n", "utf8");
}
