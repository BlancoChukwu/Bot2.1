import type { LoggerLike } from "../bot";
import type { SupportedChain } from "../config/chains";

export interface OpportunityTrace {
  readonly opportunityId: string;
  readonly chain: SupportedChain;
  readonly flashblockIndex?: number;
  readonly detectionTsMs: number;
  readonly simulationTsMs: number;
  readonly wouldSubmitTsMs: number;
  readonly estProfitAfterFeeGasUsd: number;
}

export function logOpportunityTrace(logger: LoggerLike, trace: OpportunityTrace): void {
  logger.info("opportunity_trace_cycle", {
    opportunityId: trace.opportunityId,
    chain: trace.chain,
    flashblock_index: trace.flashblockIndex ?? -1,
    detection_ts: trace.detectionTsMs,
    simulation_ts: trace.simulationTsMs,
    would_submit_ts: trace.wouldSubmitTsMs,
    est_profit_after_fee_gas: trace.estProfitAfterFeeGasUsd,
  });
}

