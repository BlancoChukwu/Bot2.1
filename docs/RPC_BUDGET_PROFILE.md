# RPC budget profile (Oracle Ubuntu / quota-limited hosts)

Use when WS/RPC provider quotas are near capacity and you cannot add spend.

## Enable

**Simulation soak (always budget):** use `start-simulation.sh` or `Start Simulation Bot.cmd` — loads `.env.simulation` (`RPC_BUDGET_MODE=true`).

**Production budget:** use `start-production-budget.sh` or `Start Production Bot (Budget).cmd` — loads `.env.production.budget`.

**Production standard:** use `start-production.sh` or `Start Production Bot.cmd` — loads `.env.production` (`RPC_BUDGET_MODE=false`).

Regenerate profiles after editing secrets in `.env`:

```bash
npm run env:bootstrap
```

Optional overrides (applied only when unset):

| Variable | Budget default | Effect |
| --- | --- | --- |
| `POLL_INTERVAL_MS` | 800 | ~50% fewer poll cycles |
| `MULTICALL_BATCH_SIZE` | 125 | Smaller multicall batches |
| `LOW_TIER_EVERY_BLOCKS` | 200 | Low-HF tier swept half as often |
| `FULL_WATCHLIST_SWEEP_INTERVAL_MS` | 120000 | Less frequent full sweeps |
| `BORROWER_FULL_RESCAN_INTERVAL_MS` | 1800000 | Less borrower rescan RPC |
| `FLASHBLOCKS_PRIMARY_LOOP_MS` | 400 | Slower flashblock primary loop |
| `WATCHLIST_MAX_STALE_MS` | 120000 | Staleness guard aligned to slower sweeps |

## Validation gates (relaxed 2×)

With `RPC_BUDGET_MODE=true`, `GATE_SCALE_FACTOR` defaults to **2** (double allowed latency/RSS limits, half required event counts where applicable).

| Check | Standard | Budget (`GATE_SCALE_FACTOR=2`) |
| --- | --- | --- |
| WS `newHeads` p95 (`check-rpc-benchmark-gates`) | &lt; 50 ms | &lt; 100 ms |
| `flashblock_to_detection_ms` p99 (alerts) | 50 ms | 100 ms |
| `detection_to_simulation_ms` p99 | 100 ms | 200 ms |
| `simulation_to_would_submit_ms` p99 | 30 ms | 60 ms |
| `watchlist_last_update_age_seconds` alert | 60 s | 120 s |
| 24h audit RSS growth | &lt; 10 MB/h | &lt; 20 MB/h |
| 24h audit `liquidation_evaluated` | ≥ 50 | ≥ 25 |
| Competitive gap `sameBlockRatio` | ≥ 0.70 | ≥ 0.35 (`COMPETITIVE_GAP_MIN_RATIO`) |

Prometheus: load [`prometheus/alerts/bot_critical_budget.yml`](../prometheus/alerts/bot_critical_budget.yml) instead of `bot_critical.yml`.

## Commands

```bash
npm run benchmark:rpc
npm run check:rpc-gates
npm run test:flashblocks
node scripts/audit-session.mjs logs/simulation-*.log
npm run report:competitive-gap
```

## Further quota cuts (manual)

These are not auto-set; consider when still over quota:

- Leave `WS_RPC_URL_TERTIARY` empty (two WS feeds instead of three).
- `FLASHBLOCKS_ENABLED=false` if not running flashblock primary loop.
- `SKIP_COLD_START_FULL_SWEEP=true` during restarts (startup only).
- Shorter `COLD_START_LOOKBACK_BLOCKS` only if you accept smaller historical watchlist.

## Trade-off

Lower RPC duty cycle **reduces detection freshness** and competitive same-block win rate. Budget mode is for staying within provider limits, not for maximum MEV capture.
