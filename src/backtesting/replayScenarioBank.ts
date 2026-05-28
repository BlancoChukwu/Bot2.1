import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ReplayScenario {
  readonly id: string;
  readonly kind: "liquidation" | "arbitrage";
  readonly healthFactor?: string;
  readonly debtUsd?: number;
  readonly pair?: string;
  readonly edgeBps?: number;
}

export function loadReplayScenarioBank(): readonly ReplayScenario[] {
  const basePath = join(process.cwd(), "test", "fixtures", "replay-scenarios.json");
  const fromFile = JSON.parse(readFileSync(basePath, "utf8")) as ReplayScenario[];
  const generated: ReplayScenario[] = [];
  for (let i = 0; i < 50; i += 1) {
    generated.push({
      id: `generated-liq-${i}`,
      kind: "liquidation",
      healthFactor: (0.9 + (i % 10) * 0.01).toFixed(2),
      debtUsd: 100 + i * 25,
    });
  }
  return [...fromFile, ...generated];
}
