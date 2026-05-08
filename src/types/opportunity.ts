import type { LiquidationCandidate } from "../protocols/aaveV3";
import type { ArbitrageOpportunity } from "../monitors/arbitrageScanner";

export type OpportunityKind = "liquidation" | "arbitrage";

export interface LiquidationOpportunity {
  readonly kind: "liquidation";
  readonly candidate: LiquidationCandidate;
}

export interface ArbitragePipelineOpportunity {
  readonly kind: "arbitrage";
  readonly candidate: ArbitrageOpportunity;
}

export type Opportunity = LiquidationOpportunity | ArbitragePipelineOpportunity;

export function fromLiquidationCandidate(candidate: LiquidationCandidate): LiquidationOpportunity {
  return {
    kind: "liquidation",
    candidate,
  };
}

export function fromArbitrageOpportunity(candidate: ArbitrageOpportunity): ArbitragePipelineOpportunity {
  return {
    kind: "arbitrage",
    candidate,
  };
}
