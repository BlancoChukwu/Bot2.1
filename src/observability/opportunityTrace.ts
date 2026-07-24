import type { SupportedChain } from "../config/chains";
import type { LoggerLike } from "../bot";

export type AttemptPhase =
  | "opportunity_seen"
  | "simulated"
  | "broadcast"
  | "receipt";

export interface OpportunityTrace {
  readonly opportunityId: string;
  readonly chain: SupportedChain;
  readonly flashblockIndex?: number;
  readonly detectionTsMs: number;
  readonly simulationTsMs: number;
  readonly wouldSubmitTsMs: number;
  readonly estProfitAfterFeeGasUsd: number;
  readonly localHfWad?: string;
  readonly chainHfWad?: string;
  readonly simOk?: boolean;
  readonly simRevertReason?: string;
  readonly gasEstimate?: string;
  readonly broadcastHash?: string;
  readonly receiptStatus?: string;
  readonly receiptRevertReason?: string;
}

/** Structured first-attempt log — opportunity → sim → broadcast → receipt. */
export function logOpportunityTrace(logger: LoggerLike, trace: OpportunityTrace): void {
  logger.info("opportunity_trace_cycle", {
    opportunityId: trace.opportunityId,
    chain: trace.chain,
    flashblock_index: trace.flashblockIndex ?? -1,
    detection_ts: trace.detectionTsMs,
    simulation_ts: trace.simulationTsMs,
    would_submit_ts: trace.wouldSubmitTsMs,
    est_profit_after_fee_gas: trace.estProfitAfterFeeGasUsd,
    ...(trace.localHfWad === undefined ? {} : { local_hf_wad: trace.localHfWad }),
    ...(trace.chainHfWad === undefined ? {} : { chain_hf_wad: trace.chainHfWad }),
    ...(trace.simOk === undefined ? {} : { sim_ok: trace.simOk }),
    ...(trace.simRevertReason === undefined ? {} : { sim_revert_reason: trace.simRevertReason }),
    ...(trace.gasEstimate === undefined ? {} : { gas_estimate: trace.gasEstimate }),
    ...(trace.broadcastHash === undefined ? {} : { broadcast_hash: trace.broadcastHash }),
    ...(trace.receiptStatus === undefined ? {} : { receipt_status: trace.receiptStatus }),
    ...(trace.receiptRevertReason === undefined
      ? {}
      : { receipt_revert_reason: trace.receiptRevertReason }),
  });
}

export interface FirstAttemptLogInput {
  readonly opportunityId: string;
  readonly chain: SupportedChain;
  readonly account: string;
  readonly phase: AttemptPhase;
  readonly localHfWad?: string;
  readonly chainHfWad?: string;
  readonly simOk?: boolean;
  readonly simRevertReason?: string;
  readonly gasEstimate?: string;
  readonly broadcastHash?: string;
  readonly receiptStatus?: string;
  readonly receiptRevertReason?: string;
  readonly estProfitAfterFeeGasUsd?: number;
}

export function logFirstAttempt(logger: LoggerLike, input: FirstAttemptLogInput): void {
  logger.info("liquidation_first_attempt", {
    opportunityId: input.opportunityId,
    chain: input.chain,
    account: input.account,
    phase: input.phase,
    ...(input.localHfWad === undefined ? {} : { local_hf_wad: input.localHfWad }),
    ...(input.chainHfWad === undefined ? {} : { chain_hf_wad: input.chainHfWad }),
    ...(input.simOk === undefined ? {} : { sim_ok: input.simOk }),
    ...(input.simRevertReason === undefined ? {} : { sim_revert_reason: input.simRevertReason }),
    ...(input.gasEstimate === undefined ? {} : { gas_estimate: input.gasEstimate }),
    ...(input.broadcastHash === undefined ? {} : { broadcast_hash: input.broadcastHash }),
    ...(input.receiptStatus === undefined ? {} : { receipt_status: input.receiptStatus }),
    ...(input.receiptRevertReason === undefined
      ? {}
      : { receipt_revert_reason: input.receiptRevertReason }),
    ...(input.estProfitAfterFeeGasUsd === undefined
      ? {}
      : { est_profit_after_fee_gas: input.estProfitAfterFeeGasUsd }),
  });
}
