# Progress snapshot

**Date:** 2026-05-22 (branch `new-team-in-town`)

## Shipped on this branch

- **Memory:** `memoryMonitor.checkNow()` on every `hybrid_detection_failure` plus 60s `memory_stats` backup.
- **Arbitrage diagnostics:** `arbitrage_quotes_fetched`, `arbitrage_evaluation_skipped`; audit script extended.
- **WSS:** `wss_provider_unstable_host_detected` for Dwellir-tier hosts; README WSS checklist.
- **newHeads:** Primary WSS block subscription → debounced watchlist rescan (`block_triggered_watchlist_rescan`).
- **Subgraph lag:** `subgraph_lag_detected` guard on borrower watchlist rescans.
- **Multi-protocol discovery:** Moonwell + Seamless subgraph adapters (env-gated); execution gated by `ENABLE_NON_AAVE_LIQUIDATION=false`.
- **PM2:** `ecosystem.config.cjs` with `max_memory_restart: 3G`.

## Ops after 12h clean session

1. `node scripts/audit-session.mjs logs/<session>.log` — all metrics PASS, `hybrid_detection_failure=0`.
2. Set `MIN_LIQUIDATION_DEBT_USD=0.35` (not `0` until discovery is live).
3. `pm2 start ecosystem.config.cjs`.

## Deferred

- Morpho Blue / Compound V3 adapters.
- FTRL provider scoring upgrade (`docs/plans/ftrl-provider-scoring-upgrade.plan.md`).
