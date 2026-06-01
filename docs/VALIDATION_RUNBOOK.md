# Base watchlist validation runbook

## Gate 0

```bash
npm test
npm run typecheck
```

## P0 pre-flight (before soak)

Clear stale lock and confirm no bot is running:

```powershell
cd "e:\Mini PC\optimism-aave-v3-liquidator-ts"
npm run bot:stop
npm run bot:status
```

`bot:stop` kills live bot PIDs and removes a stale `.runtime/bot.lock` when the holder is dead.

## P0 debug HF sweep (run before soak)

Answers whether `liquidatable: 0` is calm market vs `MIN_LIQUIDATION_DEBT_USD` vs seed coverage.

```bash
npm run debug:hf-sweep-base
```

Probe with $1 debt floor (exposes min-debt gate):

```bash
npx ts-node scripts/debug-hf-sweep-base.ts --min-debt-base 100000000
```

- Exit **0** — verdict in JSON summary (`MARKET_CALM`, `MIN_DEBT_GATE_LIKELY_CULPRIT`, etc.)
- Exit **2** — probe finds liquidatable positions that env min-debt blocks (fix `.env` for sim, e.g. `MIN_LIQUIDATION_DEBT_USD=1`)

Default env min debt when unset: `max(MIN_PROFIT_USD, 50)` → typically **$50** USD (8-decimal base units on-chain).

### Calm-market baseline (accepted 2026-05-24)

P0 debug sweep on Base (`npm run debug:hf-sweep-base`) — **accepted** for Phase 1 soak greenlight:

| Field | Value |
| --- | --- |
| `stillUnhealthyAfterLiquidation` | **1** |
| `probeLiquidatableCount` / `envLiquidatableCount` | **0** / **0** |
| `blockedByEnvMinDebtOnly` | **0** |
| Summary `verdict` | `INVESTIGATE_SEED_COVERAGE_OR_HF` (script label; see resolution below) |

**Exact log line** (`still_unhealthy_after_liquidation`):

```json
{"msg":"still_unhealthy_after_liquidation","address":"0xb17c285422CAB46Bfddc552A811957a7899D44a7","healthFactor":"0.9384595626472435","debtUsd":"0.01"}
```

**Single-address investigation** (`npx ts-node scripts/investigate-address-watchlist.ts 0xb17c285422CAB46Bfddc552A811957a7899D44a7`):

| Check | Result |
| --- | --- |
| Current HF (`getUserAccountData`) | **0.938** (< 1.0) |
| `debtUsd` | **~$0.009** (on-chain `totalDebtBase` ≈ 902 841) |
| `sweepLiquidatable` (env `minDebtUsd` = 50) | **false** — debt ≪ $50 floor |
| `inWatchlistAfterColdStart` (50k-block RPC replay) | **false** |
| `inTieredSweepTargets` | **false** |
| Last `LiquidationCall` for user (chunked pool logs) | block **46162328** (~**296k** blocks before head; outside 50k cold-start window) |
| `LiquidationCall` in last 50k blocks | **0** logs |

**Resolution (not a soak blocker):**

1. **Not an HF sweep bug** — direct `getUserAccountData` and `sweepHealthFactors` agree; HF uses index `[5]` on pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`.
2. **Not economically liquidatable** — residual **dust** after partial liquidation; intentionally below `MIN_LIQUIDATION_DEBT_USD` / revenue gate (≪ $500).
3. **Watchlist gap is historical coverage, not live-path failure** — user was liquidated ~296k blocks ago; default `COLD_START_LOOKBACK_BLOCKS=50000` does not replay that far. Live `LiquidationCall` WS/replay **does** add the borrower when the bot is running at liquidation time.
4. **No code change required for P0** — extending cold-start to 300k+ blocks only to track $0.01 dust is high RPC cost with zero liquidation value.

**Soak greenlight:** proceed with **2h detached simulation** when runtime checks pass (Redis, breaker, gap replay, RSS). `liquidatable: 0` in calm market is expected until debt ≥ env min debt and HF < 1.

### Watchlist staleness failure + fix (2026-05-25)

**Failure (`simulation-20260525-050746.log`, ~72 min):**

- Only **one** `watchlist_sweep_complete` (startup `pollFallback` only).
- **105** `watchlist_stale` warnings; `ageMs` climbed **60s → 107s** (pass target: **< 30s**).
- Root cause: no periodic HF sweep after cold start — `stalenessGuard` was never refreshed.

**Fix (Phase 1.4 tiered sweep):**

- `WatchlistCoordinator.sweepAndRefresh` / `runTieredSweep` — records HF on every successful multicall read, refreshes `stalenessGuard`.
- Tiering: HF unknown or **< 1.15** → every block; HF **≥ 1.15** → every **100** blocks (`lowTierEveryBlocks`).
- **Primary WSS `onBlock`** → `pollBorrowers` + cache upsert (rebuilt `dist` required).
- **No WSS** fallback → `PipelineOrchestrator.watchlistSweep` each poll cycle.

**Re-soak verification checklist:**

```powershell
npm run build
# Start Simulation Bot.cmd
Select-String -Path logs\simulation-*.log -Pattern 'watchlist_sweep_complete' | Measure-Object   # expect many
Select-String -Path logs\simulation-*.log -Pattern 'watchlist_stale' | Measure-Object          # expect 0 after ~60s warmup
```

Pass: multiple `watchlist_sweep_complete` (~1 per Base block), no sustained `watchlist_stale`, then run full **2h** detached soak.

**Re-soak spot-check (`simulation-20260525-064215.log`, first ~3 min after fix):**

- **79** `watchlist_sweep_complete` (~2s apart, per-block WSS hook)
- **0** `watchlist_stale`
- Tiering active: `scanned: 56` per block (high-signal subset of ~1482 watchlist; low tier on block % 100)
- Redis + rescanner disabled confirmed at startup

Proceed with full **2h** detached soak on this build.

2026-05-25 — 3.65 h Base soak (simulation-20260525-080621.log) — GREEN
- Periodic sweeps: 6,573 (tiered high-signal every block)
- Staleness: 0 warnings
- Memory: RSS 160→297 MB (heap-t5 vs heap-t35 passed)
- liquidatable: 0 (calm market accepted)
- Next gate: liquidation path proof required before Phase 1b

2026-05-25 — Fork revenue-path proof (fork-proof-post-fix.log) — GREEN
- `liquidation_path_candidate` fired on drifted borrower (`cold_start_full_sweep`)
- Scanned 28,704 addresses, 2 liquidatable, quotes path proven
- Phase 1 complete on Base Aave V3
- Next: ship Phase 1b metrics/alerts → 72h live run

## RPC budget profile (Oracle Ubuntu)

When provider WS/RPC quotas are near limit, enable `RPC_BUDGET_MODE=true` on the VM. See [RPC_BUDGET_PROFILE.md](./RPC_BUDGET_PROFILE.md) for halved duty cycle and 2× relaxed validation thresholds.

## Phase 3 go-live gates

Run these checks before enabling first live Moonwell/Morpho target liquidation:

```bash
npm test && npm run typecheck
npm run benchmark:rpc
npm run test:flashblocks
npm run audit:morpho-preliquidation-base
npm run report:competitive-gap
npm run review:daily-pipeline
```

Required outcomes (standard; with `RPC_BUDGET_MODE=true` thresholds are 2× — see RPC_BUDGET_PROFILE.md):

- `flashblock_to_detection_ms` p99 < 50ms (48h shadow window; **100ms** budget)
- `detection_to_simulation_ms` p99 < 100ms (**200ms** budget)
- `simulation_to_would_submit_ms` p99 < 30ms (**60ms** budget)
- Competitive gap report exits 0 with same-block ratio >= 0.70 (**0.35** budget)
- Daily review reports `unhandledReverts` <= configured threshold

## Phase 1b — Watchlist metrics + alerts

Prometheus scrape target: `http://127.0.0.1:9090/metrics` (started with bot).

| Metric | Type | Labels |
| --- | --- | --- |
| `watchlist_size_total` | gauge | `chain` |
| `watchlist_last_update_age_seconds` | gauge | `chain` |
| `watchlist_circuit_breaker_open` | gauge | `chain` |
| `watchlist_gap_replay_total` | counter | `chain` |
| `watchlist_stale_evaluations_total` | counter | `chain`, `severity` |
| `process_rss_bytes` | gauge | — |

Alert rules: [`prometheus/alerts/bot_critical.yml`](../prometheus/alerts/bot_critical.yml) — also served at `GET /alerts` on port 9090. Load into Prometheus with:

```yaml
rule_files:
  - prometheus/alerts/bot_critical.yml
```

Pass before 72h live: `watchlist_circuit_breaker_open == 0`, `max(watchlist_last_update_age_seconds) < 60` (**120** with RPC budget), RSS stable, `watchlist_gap_replay_total` increments on restart.

## Multicall batch probe (before soak)

```bash
npm run probe:multicall-base
```

Target: **< 400 ms per multicall batch** (not total sweep). On Base mainnet RPC (2026-05-25): batch 500 ≈ 700–1200 ms → use **250** (`MULTICALL_BATCH_SIZE=250`, default in `index.ts`). Subgraph quota may force RPC log seed during probe; cold-start path still works.

## Block cursor (production)

Set `REDIS_URL` so `lastProcessedBlock` survives restarts. Start portable Redis from `.runtime/redis/` if needed. Without Redis, startup logs `block_cursor_in_memory` at **error** level.

## Phase 1 — 2h soak (Base)

```env
CHAIN=base
USE_EVENT_WATCHLIST=true
ENABLE_HEAP_SNAPSHOTS=true
SIMULATION_MODE=true
REDIS_URL=redis://127.0.0.1:6379
```

**Single instance only.** After calm-market baseline above is accepted and Redis is up:

1. `npm run bot:stop`
2. Double-click **`Start Simulation Bot.cmd`** (detached — survives closing Cursor/terminal; do **not** use background `npm run start:sim` in IDE for 2h)
3. Tail: `Get-Content logs\simulation-*.log -Wait -Tail 20` (path in `logs\latest-session.txt`)

Pass criteria:

- Runtime **≥ 2 hours** without parent-shell exit
- RSS stable between heap snapshots at T+5m and T+35m
- No repeated `borrower_watchlist_rescan_failed` / `watchlist_circuit_breaker_open` storms
- `watchlist_gap_replay_complete` on restart after brief stop
- `watchlist_sweep_complete` with reasonable `watchlistSize`

## Revenue gate — liquidation path (Base)

Before Phase 2 arb diagnostics:

1. Debug sweep + soak logs show candidate with `HF < 1.0` and debt above threshold, or documented calm market

## Phase 0 — 24h memory gate (blocking)

Run detached simulation with event watchlist and memory snapshots:

```powershell
cd "e:\Mini PC\optimism-aave-v3-liquidator-ts"
$env:SIMULATION_MODE="true"
$env:USE_EVENT_WATCHLIST="true"
$env:ENABLE_HEAP_SNAPSHOTS="true"
$env:MEMORY_LOG_EVERY_CYCLES="300"
scripts\launcher-run-bot-detached.cmd
```

Gate checks after 24h:

```powershell
node scripts/audit-session.mjs "logs\<session>.log"
```

### Post-deploy memory diagnostic (first 4 hours)

Run **before** tuning profitability or execution:

1. Confirm `NODE_OPTIONS` includes `--max-old-space-size=650` and Docker `mem_limit: 1100m` (see README).
2. Send **SIGUSR2** to the bot PID at **T+0h, T+2h, T+4h** — snapshots land in `.runtime/heap-signal-*.heapsnapshot`.
3. In Chrome DevTools → Memory, compare retained object counts by constructor across the three files.
4. If RSS growth **> 30 MB/hour** after dedupe LRU fix, inspect `memory_stats` component counters (`watchlistSize`, `cacheEntries`, `detectionPending`) and Prometheus label cardinality (per-address labels).
5. Append RSS slope from `audit-session.mjs` to `logs/latest-session.txt` for the run record.

Pass criteria:

- `memory_ceiling_hit = 0`
- RSS growth `< 10 MB/hour` (`memory_rss_growth_rate` metric in audit output; **20 MB/hour** with RPC budget); investigate if **> 30 MB/hour** (**60** budget)
- No self-exit loop (`launcher_session_exit` should not appear unexpectedly)
- RSS remains below 400 MB steady state for the session window (**800 MB** Prometheus alert in budget profile)
2. `buildLiquidationExecutionRequest` succeeds in sim
3. Dry-run preview passes deployment safety gate
4. Live: one tx with `liquidation_path_validated` log, or signed dry-run receipt

### Immediate next action — liquidation path proof (mandatory)

**Completed 2026-05-25** — fork proof GREEN (`fork-proof-post-fix.log`). Proceed to Phase 1b metrics + 72h live run.

- **Option A (fastest):** run on Base fork with a deliberate test borrower (`HF < 1.05`, debt `> $500`), force sweep, verify `liquidation_path_candidate` and successful quote path.
- **Option B:** wait for a volatile window and monitor Base Aave V3 liquidations live (Dune/DeFiLlama), then capture the same proof in production logs.

## 72h stable

Continuous run on Base with `USE_EVENT_WATCHLIST=true` before Ethereum / Morpho expansion.
