/**
 * When RPC_BUDGET_MODE=true, applies ~50% lower RPC/WS duty cycle via env defaults
 * and scales validation gate limits by GATE_SCALE_FACTOR (default 2).
 */
function parseTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isRpcBudgetMode(): boolean {
  return parseTruthy(process.env.RPC_BUDGET_MODE);
}

/** Multiplier for pass thresholds (latency ms, RSS MB/h, min event counts). */
export function gateScaleFactor(): number {
  const raw = process.env.GATE_SCALE_FACTOR?.trim();
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return isRpcBudgetMode() ? 2 : 1;
}

export function scaledGateLimit(base: number): number {
  return base * gateScaleFactor();
}

/** Only sets env keys that are not already defined. */
export function applyRpcBudgetEnvDefaults(): void {
  if (!isRpcBudgetMode()) {
    return;
  }
  const defaults: Record<string, string> = {
    POLL_INTERVAL_MS: "800",
    MULTICALL_BATCH_SIZE: "125",
    FULL_WATCHLIST_SWEEP_INTERVAL_MS: "120000",
    BORROWER_FULL_RESCAN_INTERVAL_MS: "1800000",
    BLOCK_RESCAN_DEBOUNCE_MS: "4000",
    ORACLE_POLL_INTERVAL_MS: "120000",
    CANDIDATE_COOLDOWN_MS: "60000",
    LOW_TIER_EVERY_BLOCKS: "200",
    FLASHBLOCKS_PRIMARY_LOOP_MS: "400",
    WATCHLIST_MAX_STALE_MS: "120000",
    NEAR_LIQ_POLL_MS: "400",
    MEMORY_LOG_EVERY_CYCLES: "600",
    GATE_SCALE_FACTOR: "2",
    COMPETITIVE_GAP_MIN_RATIO: "0.35",
    RPC_BENCH_WS_SAMPLES: "10",
    RPC_BENCH_CALL_SAMPLES: "10",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] === undefined || process.env[key]?.trim() === "") {
      process.env[key] = value;
    }
  }
}
