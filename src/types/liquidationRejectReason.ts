/**
 * Shared typed reject reasons for prestage and hot liquidation drops.
 * Stage B emits these from day one; Stage C only wires remaining sites / metrics.
 */
export type LiquidationRejectReason =
  | "unmapped_pair"
  | "thin_cap_unprofitable"
  | "quoter_zero"
  | "quoter_revert"
  | "slippage_over_buffer"
  | "ev_below_floor"
  | "dust"
  | "hf_not_liquidatable"
  | "stale_payload";

export const LIQUIDATION_REJECT_REASONS: readonly LiquidationRejectReason[] = [
  "unmapped_pair",
  "thin_cap_unprofitable",
  "quoter_zero",
  "quoter_revert",
  "slippage_over_buffer",
  "ev_below_floor",
  "dust",
  "hf_not_liquidatable",
  "stale_payload",
] as const;
