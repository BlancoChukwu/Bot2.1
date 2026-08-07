# Event-Purity Architecture (P0)

## RPC topology

| Role | Env | Provider |
|---|---|---|
| Ingestion | `WS_RPC_URL_PRIMARY` | Alchemy or QuickNode Flashblocks WSS |
| Execution | `EXECUTION_RPC_URL_PRIMARY` | NodeReal (or cost-optimized HTTP) |

## WS subscriptions (zero HTTP poll)

- `eth_subscribe("pendingLogs", { address: pool })` — Aave pool pre-confirmed events
- `eth_subscribe("logs", { address: feed, topics: [AnswerUpdated] })` — Chainlink prices
- `eth_subscribe("newFlashblocks")` — ~200ms clock for checkpoints + reserve index refresh

**Removed:** `flashblocksPendingLogSource` HTTP `getLogs("pending")` every 200ms (~432k calls/day).

## P0 shadow mode

- `ENABLE_LIVE_TX=false` — no simulate/send; liquidatable candidates are logged only
- `ENABLE_ARBITRAGE=false` — arb scanner and queue disabled
- `ENABLE_WATCH_TIER_CONFIRM=false` — Watch tier is classify-only; Urgent + shadow samples RPC

## Modules

- `wsEventLayer.ts` — subscriptions, dedup, gap-fill on execution HTTP
- `localPositionModel.ts` — local HF from events + prices
- `tieredConfirmQueue.ts` — Multicall confirm (Urgent)
- `shadowValidator.ts` — rate-limited drift sampling
- `partialBootstrapSweep.ts` — log/subgraph/cache bootstrap with RPC rotation
- `bootstrapSnapshotStore.ts` — disk cache for near-instant restarts
- `eventPurityStack.ts` — wires the above; started from `index.ts` when `USE_EVENT_WATCHLIST` + `FLASHBLOCKS_ENABLED`

## Observability

- Prometheus: `bootstrap_users_seeded{chain,bootstrap_source}`, `event_purity_position_cache_size{chain}`, `bootstrap_source_info{chain,bootstrap_source}`
- HTTP `GET /status` on metrics port (9090): `bootstrapSource`, `usersSeeded`, `positionCacheSize`, `bootstrapCacheHit`
- HTTP `GET /healthz` includes bootstrap fields when available (for MCP / dashboard polling)

## P0 exit gate

**Phase 0 (before soak clock):**

1. eMode-segmented shadow metrics — tune on `shadow_drift_non_eMode_bps` / `shadow_fn_rate_non_eMode_pct`; eMode bucket is diagnostic only.
2. Partial bootstrap — `partial_bootstrap_coverage` log must show thousands of seeded users, not dozens.

**Phase 1 soak (24–48h):**

- Non-eMode drift within `SHADOW_DRIFT_TOLERANCE_BPS`
- Non-eMode FN rate at or below `SHADOW_FN_RATE_TARGET_PCT`
- `rpc_pending_getlogs_total == 0`
- `position_cache_size` stable with meaningful bootstrap coverage %
- Review eMode bucket volume/drift — pull full eMode LT math to P0 if material

## Tiered pre-stage (Stages A–C)

### Config knobs

| Env | Default | Notes |
|---|---|---|
| `PRESTAGE_ENABLED` | true when `USE_EVENT_WATCHLIST=true` | Prep-only; never speculative submit |
| `PRESTAGE_HF_UPPER` | `1.02` | Band upper (inclusive) above HF 1.0 |
| `PRESTAGE_TOP_N` | `10` | Full Quoter/encode only for top-N |
| `PRESTAGE_TTL_MS` | `15000` | Payload TTL |
| `PRESTAGE_MIN_REFRESH_INTERVAL_MS` | `1500` | Per-account refresh backstop |
| `LIQUIDATION_SWAP_SLIPPAGE_BPS` | `200` | Shared oracle-floor **and** prestage price-invalidate threshold |

### Close-factor SSoT

`resolveCloseFactorBps` in `src/config/closeFactor.ts`: 100% if HF ≤ 0.95 **or** collateral/debt &lt; $2000; else 50%. Applied at `createReserveAwareCandidates`; `eligibleCandidate` never double-haircuts.

### Verify greps

```bash
rg 'pipeline_cycle_sample' logs/… | rg debtUsd
rg 'evUncapped' logs/… | rg evCapped
rg '"msg":"prestage_enter"' logs/…
rg '"msg":"prestage_promote_to_hot".*"cacheHit":true' logs/…
rg '"msg":"prestage_send".*"reusedPayload":true' logs/…
rg shadow_validation_aggregate logs/… | rg 'shadow_drift_fresh|shadow_drift_stale'
```

### Pinned fork fixture (Stage B merge blocker)

- File: `test/fixtures/historical-liquidation-base.json`
- Block `46925615` / snapshot `46925614` / user `0x4118BB35A8068732da2c4fb49b12AbA59D39Adec`
- Test: `test/integration/prestageHistoricalLiquidation.fork.test.ts` — enter → promote → encode with CF + capped `debtToCover`
