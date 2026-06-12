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
