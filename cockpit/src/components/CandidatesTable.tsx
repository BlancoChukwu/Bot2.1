import type { LiquidationCandidate } from "../types/telemetry";
import { Panel } from "./Panel";

interface CandidatesTableProps {
  candidates: LiquidationCandidate[];
  minProfitFloorUsd: number;
}

export function CandidatesTable({ candidates, minProfitFloorUsd }: CandidatesTableProps) {
  const ranked = [...candidates].sort((a, b) => b.projectedProfitUsd - a.projectedProfitUsd);

  return (
    <Panel title="Liquidation candidates · ranked">
      {ranked.length === 0 ? (
        <p className="font-mono text-xs text-muted">
          Candidates not available in v1 — core status, alerts, and activity stream are live.
        </p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="text-left text-xs text-muted uppercase tracking-wide">
                <th className="px-1 py-1">Account</th>
                <th className="px-1 py-1">HF</th>
                <th className="px-1 py-1">Profit</th>
                <th className="px-1 py-1">Coll</th>
                <th className="px-1 py-1">Chain</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((row) => {
                const aboveFloor = row.projectedProfitUsd >= minProfitFloorUsd;
                return (
                  <tr
                    key={row.id}
                    className={aboveFloor ? "bg-amber/10 text-amber" : "text-phosphor"}
                  >
                    <td className="px-1 py-2">{row.account}</td>
                    <td className="px-1 py-2">{row.healthFactor.toFixed(3)}</td>
                    <td className="px-1 py-2">${row.projectedProfitUsd.toFixed(2)}</td>
                    <td className="px-1 py-2">{row.collateral}</td>
                    <td className="px-1 py-2 uppercase">{row.chain}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
