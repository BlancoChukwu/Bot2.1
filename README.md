# Chain-Agnostic Aave V3 Liquidator

A TypeScript (Node.js) bot that watches **Aave V3** users on **Layer 2** (Optimism first; Arbitrum configuration included). When a borrow position becomes unhealthy, a **liquidator** can repay part of the debt and seize a discounted amount of collateral. This project automates finding candidates and (optionally) sending liquidation transactions.

**This is not financial advice.** Liquidation bots compete on speed, capital, and infrastructure. You can lose money (failed txs, gas, wrong parameters). Treat every run as high risk.

---

## For complete beginners

### Words you will see

- **Aave V3** — A lending protocol: users **deposit** collateral, **borrow** against it, and must keep a **health factor** above `1.0`. If it drops below `1.0`, the position can be **liquidated**.
- **Health factor (HF)** — A ratio of collateral value vs. debt. Above `1` is “safe enough”; at or below `1`, liquidations are allowed (subject to protocol rules).
- **Liquidation** — You repay some of the user’s debt (often using a **flash loan**) and receive collateral plus a **liquidation bonus**. Profit is not guaranteed: gas, slippage, competition, and oracle latency matter.
- **RPC** — Your connection to the blockchain (HTTP or WebSocket URL from a provider). Without a good RPC, you see stale data and miss or revert transactions.
- **Subgraph** — A **GraphQL index** that lists many borrowers quickly. The bot still **verifies** critical data **on-chain** before acting.
- **Simulation mode** — The bot **does not broadcast** transactions; it only **simulates** what would happen. Use this until you understand logs, RPC behavior, and risk.
- **Live mode** — The bot may **send real transactions** from your wallet. **Live startup is guarded** by a **deployment safety gate** (recent dry-run validation, margin, chains). See [Simulation vs live](#simulation-vs-live).

### What happens when you run the bot (default entry)

The command `npm run start:sim` runs `src/index.ts`, which wires together:

1. **Metrics server** — Prometheus metrics and a JSON health check (see [Observability](#observability)).
2. **Deployment safety gate** — If you attempt **live** mode without required checks, the process **exits** with an error log (see below).
3. **Aave protocol adapter** — Talks to the Aave V3 pool using **viem**.
4. **Subgraph + optional WebSocket** — Discovers borrowers from the subgraph; can subscribe to on-chain events when `WS_RPC_URL` is set.
5. **Health factor monitor** — Polls on an interval (fixed **400 ms** in config), rebuilds candidates whose HF is below `1.0`, applies **EV / profit** filters.
6. **Liquidation executor** — For each passing candidate, **estimates gas**, **simulates** the `liquidationCall`, and either stops there (simulation) or **broadcasts** (live).

This repository also contains **additional modules** under `src/` (for example `chainRegistry`, `hybridDetectionPipeline`, `profitabilityEngine`, `safeTransactionExecutor`, `pipelineOrchestrator`). They are heavily tested and intended for **advanced composition**; the **stock** `npm start` path uses the **monitor + executor** loop above. When reading tests or extending the bot, explore those folders.

---

## Prerequisites

- **Node.js** (LTS recommended) and **npm**.
- A machine with stable network (this doc matches **Windows 11** as well as macOS/Linux).
- An **Optimism** (or other supported chain) **RPC URL** and a working **Aave V3 subgraph** endpoint or **The Graph API key** (see [Environment](#environment-variables)).
- A **dedicated hot wallet** funded with a **small** amount of ETH on the chain you use (gas only—**not** your main wallet).

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the example file:

```bash
cp .env.example .env
```

On **PowerShell** (Windows):

```powershell
Copy-Item .env.example .env
```

Edit `.env` and set at least:

- `RPC_URL` — your primary HTTP RPC.
- Either an Aave V3 **indexing subgraph** `AAVE_SUBGRAPH_URL`, or `THE_GRAPH_API_KEY`, or for Base-only setups `BASE_AAVE_SUBGRAPH_URL` (see `.env.example`). The hosted AaveKit URL `https://api.v3.aave.com/graphql` is **not** valid for subgraph settings.
- `PRIVATE_KEY` — **only** a burner hot wallet (never the `.example` all-zeros key in production).

### 3. Run in simulation (safe default)

```bash
npm run start:sim
```

Watch logs: you should see polling cycles and simulated liquidations **without** spending funds.

### 4. Run tests (recommended before changing anything)

```bash
npm test
npm run typecheck
npm run build
```

---

## Simulation vs live


| Mode       | `SIMULATION_MODE` | Sends transactions?     |
| ---------- | ----------------- | ----------------------- |
| Simulation | `true` (default)  | No — simulations only   |
| Live       | `false`           | Yes — if all gates pass |


**Scripts**

- `npm run start:sim` — runs with your `.env` (typically `SIMULATION_MODE=true`).
- `npm run start:live` — forces `SIMULATION_MODE=false` via `cross-env` (Windows-friendly).

**Windows desktop launchers** (double-click or run `powershell -ExecutionPolicy Bypass -File scripts\create-desktop-shortcuts.ps1` to install shortcuts on your Desktop):

| File | Purpose |
|------|---------|
| `Start Event-Purity Soak.cmd` | **Recommended 48h soak:** `.env.event-purity-soak`, Flashblocks WS, shadow only |
| `Start Event-Purity Production.cmd` | **Recommended live:** `.env.event-purity-production`, `ENABLE_LIVE_TX=true`, safety gate ON |
| `Start Production Bot.cmd` | Legacy live: standard orchestrator profile |
| `Start Production Bot (No Gate).cmd` | Legacy live with `SKIP_DEPLOYMENT_SAFETY_GATE=true` |
| `Start Simulation Bot.cmd` | Legacy soak: `SIMULATION_MODE=true` |
| `Stop Bot.cmd` | Stops bot via `scripts/ensure-single-bot.mjs` |
| `Start Live Bot.cmd` | Legacy: `npm run start:live` (ts-node, not `dist/`) |

Ubuntu VM: `./start-event-purity-soak.sh` and `./start-event-purity-production.sh` (see [docs/ENV_PROFILES.md](docs/ENV_PROFILES.md)).

All start launchers call [`scripts/launcher-run-bot.cmd`](scripts/launcher-run-bot.cmd), which writes UTF-8 logs to:

- `logs/<prefix>-YYYYMMDD-HHMMSS.log` (stdout + Pino JSON)
- `logs/<prefix>-YYYYMMDD-HHMMSS.err.log` (stderr)
- `logs/latest-session.txt` — paths to the most recent run (for `audit-session.mjs`)

Example audit after a desktop run:

```powershell
$log = (Get-Content logs/latest-session.txt | Where-Object { $_ -like 'log=*' }) -replace '^log=',''
node scripts/audit-session.mjs $log
```

Launchers use `.env` in the repo folder. They do **not** bypass live safety gates (except the No Gate launcher).

### Live mode requirements (deployment safety gate)

When `SIMULATION_MODE=false`, startup **fails** unless **all** of the following are satisfied:

1. **At least one chain** is registered (`CHAIN` or `CHAINS`).
2. `**MIN_PROFIT_MARGIN_BPS`** is **≥ 50** (0.5% — enforced for **live** mode; simulation allows **≥ 40** for quote smoke tests).
3. **Dry-run validation receipt** — environment variables proving a **recent, successful** dry run **against the same config** the bot would use live:
  - `DRY_RUN_SUCCESS=true`
  - `DRY_RUN_VALIDATED_AT_MS` — Unix timestamp in milliseconds (must be recent; default freshness window is **15 minutes** in code unless you change the gate).
  - `DRY_RUN_CONFIG_HASH` — must **exactly match** the bot’s internal hash of safety-relevant settings (RPC, subgraph, chains, profit thresholds, etc.). If you change `.env`, you must **recompute** this hash or repeat your dry-run procedure.
  - `DRY_RUN_CHAINS` — comma-separated list matching your configured `CHAINS` / `CHAIN`.

If live startup is **blocked**, logs show `deployment_safety_gate_blocked` with a `reasons` array. Fix those before retrying.

**Typical workflow for beginners:** run simulation until comfortable → capture the config hash your process uses → set receipt fields after a deliberate dry-run checklist → then `start:live`.

---

## Environment variables


| Variable                                  | Required | Purpose                                                                                                              |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `CHAIN`                                   | Yes*     | Single chain: `optimism` or `arbitrum`. *Ignored as sole source if `CHAINS` is set.                                  |
| `CHAINS`                                  | No       | Comma-separated list (e.g. `optimism,arbitrum`). First chain is the **runtime** chain for this entrypoint’s clients. |
| `RPC_URL`                                 | Yes      | Primary HTTP RPC.                                                                                                    |
| `FALLBACK_RPC_URLS`                       | No       | Comma-separated backup RPCs.                                                                                         |
| `WS_RPC_URL`                              | No       | WebSocket RPC for `ReserveDataUpdated` subscription (falls back to polling if omitted).                              |
| `AAVE_SUBGRAPH_URL`                       | Conditional | Global subgraph URL for all configured chains. If unset, use `THE_GRAPH_API_KEY` and/or `BASE_AAVE_SUBGRAPH_URL` so every chain has a resolver (see README env section above). Not the AaveKit API (`api.v3.aave.com`). |
| `BASE_AAVE_SUBGRAPH_URL`                  | No       | When `CHAIN` / `CHAINS` includes **Base** and `AAVE_SUBGRAPH_URL` is unset, use this full gateway URL for Base (other chains still use `THE_GRAPH_API_KEY` if set). |
| `THE_GRAPH_API_KEY`                       | No       | If set and per-chain subgraph URLs are not fully specified, builds gateway URLs from built-in subgraph ids.          |
| `PRIVATE_KEY`                             | Yes      | `0x` + 64 hex chars. **Placeholder key is rejected in live mode.**                                                   |
| `SIMULATION_MODE`                         | No       | `true` / `false` (default `true`).                                                                                   |
| `POLL_INTERVAL_MS`                        | No       | **Must be exactly `400`** if set (validator enforces).                                                               |
| `CANDIDATE_COOLDOWN_MS`                   | No       | Suppress duplicate candidates (default `30000`).                                                                     |
| `MIN_PROFIT_THRESHOLD_ETH`                | No       | Minimum EV in ETH terms (default `0.01`).                                                                            |
| `MIN_PROFIT_USD`                          | No       | Minimum EV in USD before deeper work (default `10`).                                                                 |
| `GAS_COST_USD`                            | No       | Conservative gas dollar estimate for EV (default `0`).                                                               |
| `SLIPPAGE_BPS`                            | No       | Haircut in basis points (default `50`).                                                                              |
| `MIN_PROFIT_MARGIN_BPS`                   | No       | Minimum margin: **≥ 40** when `SIMULATION_MODE=true`, **≥ 50** when live (default `50`).                                                            |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | No       | Optional alerts for simulated/executed liquidations.                                                                 |
| `LOG_LEVEL`                               | No       | `debug`, `info`, `warn`, `error` (default `info`).                                                                   |
| `PAGERDUTY_ROUTING_KEY`                   | No       | Optional; not checked at startup. For future alert wiring (PagerDuty Events API v2 routing key).                      |
| `SKIP_DEPLOYMENT_SAFETY_GATE`             | No       | `true` bypasses dry-run receipt checks (local debugging only).                                                         |
| `DRY_RUN_*`                               | Live     | Receipt fields; see [Live mode requirements](#live-mode-requirements-deployment-safety-gate).                        |


---

## Base production runbook

### Production Base env example

```bash
CHAIN=base
CHAINS=base
USE_PIPELINE_ORCHESTRATOR=true
SIMULATION_MODE=true

# Detection WS tiers (MultiWsEventSource primary/secondary/tertiary)
WS_RPC_URL_PRIMARY=wss://<quicknode-base-ws>
WS_RPC_URL_SECONDARY=wss://<alchemy-base-ws>
WS_RPC_URL_TERTIARY=wss://<backup-base-ws>
FLASHBLOCKS_ENABLED=true

# Execution RPC path
RPC_URL=https://<base-http-primary>
FALLBACK_RPC_URLS=https://<base-http-fallback-1>,https://<base-http-fallback-2>
EXECUTION_RPC_URL_PRIMARY=https://<base-exec-http-primary>
EXECUTION_RPC_URL_FALLBACKS=https://<base-exec-http-fallback-1>,https://<base-exec-http-fallback-2>

# Private tx routing and flash-loan providers
PRIVATE_TX_MODE=auto
FLASH_LOAN_PROVIDERS=aaveV3,balancer
LIQUIDATION_RECEIVER_ADDRESS=0x...
MIN_PROFIT_MARGIN_BPS=50
```

### WSS provider checklist

- Use **three distinct hosts** for `WS_RPC_URL_PRIMARY`, `WS_RPC_URL_SECONDARY`, and `WS_RPC_URL_TERTIARY` (Alchemy + QuickNode + one backup is typical on Base).
- **Do not** use Dwellir for primary detection; startup logs `wss_provider_unstable_host_detected` when a known-unstable host is configured.
- Enable `FLASHBLOCKS_ENABLED=true` only after primary WSS is stable for several hours (`hybrid_detection_failure` should stay at 0).

### Multi-protocol borrower discovery (Moonwell + Seamless)

Phase 1 expands the watchlist via subgraph discovery only. Execution remains Aave-only unless `ENABLE_NON_AAVE_LIQUIDATION=true`.

```bash
MOONWELL_ENABLED=true
MOONWELL_SUBGRAPH_URL=https://gateway.thegraph.com/api/<KEY>/subgraphs/id/<MOONWELL_ID>
SEAMLESS_ENABLED=true
SEAMLESS_SUBGRAPH_URL=https://gateway.thegraph.com/api/<KEY>/subgraphs/id/<SEAMLESS_ID>
```

Logs: `borrower_discovery_complete`, `borrower_non_aave_skipped` (when non-Aave accounts lack Aave snapshots).

### PM2 process supervision

Production and soak launchers (`scripts/launcher-run-bot*.cmd`, `scripts/launcher-run-bot-detached.sh`, `scripts/start-live-24h.ps1`) start the bot via PM2 instead of a raw `node dist/src/index.js` process. The shared entry point is `scripts/pm2-bot-launch.mjs`, which deletes any stale app registration and runs `pm2 start ecosystem.config.cjs`.

```bash
npm run build
pm2 start ecosystem.config.cjs          # manual start
pm2 logs aave-liquidator-base           # tail stdout/stderr
pm2 status                              # confirm supervised + RSS
npm run bot:stop                        # stops PM2 app + stray node PIDs
```

**`ecosystem.config.cjs` fields (maintainer reference)**

| Field | Value | Purpose |
|-------|-------|---------|
| `name` | `aave-liquidator-base` | PM2 app id for `pm2 logs/stop/restart` |
| `script` | `dist/src/index.js` | Compiled bot entry (run `npm run build` first) |
| `instances` / `exec_mode` | `1` / `fork` | Single-process bot; no cluster |
| `autorestart` | `true` | Restart on crash |
| `max_restarts` / `min_uptime` | `10` / `10s` | Back off after rapid crash loops |
| `restart_delay` | `5s` | Pause between auto-restarts |
| `node_args` | `--max-old-space-size=1024 --expose-gc` | Heap cap + manual GC for soak diagnostics |
| `max_memory_restart` | `1200M` | PM2-level RSS guard (~6× current soak RSS) |
| `kill_timeout` | `15s` | SIGINT→SIGKILL window on `pm2 stop` / shutdown |
| `env` | production defaults | `SIMULATION_MODE=false`, safety gate on, cold-start sweep skipped |

`kill_timeout: 15_000` is sized for `ENABLE_LIVE_TX=false`. Before enabling live tx, confirm the `shutdown.addHook` chain (checkpoint close, in-flight execution drain) finishes within 15s under load, or raise this for the live profile.

Session launchers pass `--output` / `--error` to PM2 so soak logs still land in `logs/<prefix>-<timestamp>.log` alongside PM2's own log files under `~/.pm2/logs/`.

`scripts/ensure-single-bot.mjs` remains a secondary guard: `--stop` calls `pm2 stop/delete aave-liquidator-base` then kills any stray `dist/src/index.js` PIDs; `--status` still reports `lockPid` from `.runtime/bot.lock` (written by the bot process PM2 supervises).

**Gap-fill price refresh (oracle poll)**

On Base event-purity mode, the existing `ORACLE_POLL_INTERVAL_MS` timer (default 60s) runs both Chainlink feed freshness and unconditional gap-fill refresh. Grep soak logs for:

- `oracle_gap_fill_refresh_complete` — per-cycle detail (`refreshed`, `failedCount`, `targetCount`)
- `gap_fill_refresh_poll_result` — one-line poll wrapper summary (`refreshed`, `failedCount`)

After bootstrap, expect `refreshed > 0` on cycles where held positions have gap-fill assets registered in `reserveConfig`.

**Platform notes**

- **Windows** — PM2 must be installed globally (`npm i -g pm2`). `launcher-run-bot.cmd` starts PM2 and returns immediately (use `pm2 logs`, not the blocking foreground `node` path). Paths with spaces are quoted in `pm2-bot-launch.mjs`.
- **Linux** — Same `pm2-bot-launch.mjs` path via `launcher-run-bot-detached.sh`. `ensure-single-bot.mjs` uses `pgrep` for stray PID detection.
- **Not PM2-wrapped** — `scripts/live-1hr-monitor.ps1` still uses `npm run start:live` (ts-node dev path). `deploy/aave-liquidator.service` uses systemd + raw `node`.

Stale `.runtime/bot.lock` files are removed on the next start via `singleInstanceLock`.

### Gate adjustment after validation (ops)

After `node scripts/audit-session.mjs logs/<session>.log` passes for ≥12h and `dynamicFloor` in `liquidation_evaluated` events stays near $0.17–$0.20:

```bash
MIN_LIQUIDATION_DEBT_USD=0.35
```

Do not set `MIN_LIQUIDATION_DEBT_USD=0` until multi-protocol discovery is enabled and stable.

### Detection/scoring internals (what the bot does)

- `MultiWsEventSource` tracks provider quality with a Bayesian + FTRL ranking model and promotes endpoints with faster, cleaner event streams.
- When `FLASHBLOCKS_ENABLED=true`, block-driven `eth_getLogs` checks are sampled and reported as `flashblocks_lead_ms`.
- Primary WSS `newHeads` triggers debounced borrower watchlist rescans (`block_triggered_watchlist_rescan`).
- `hybrid_detection_failure` also runs an immediate memory ceiling check (graceful exit before OS OOM).
- Arbitrage cycles emit `arbitrage_quotes_fetched` (quote path diagnostics) and `arbitrage_evaluation_skipped` when quotes succeed but nothing is evaluated.
- Borrower rescans warn on `subgraph_lag_detected` when the Aave subgraph indexer is more than `SUBGRAPH_MAX_LAG_BLOCKS` behind chain head.
- The pipeline applies a sequencer guard before execution (`pipeline_execution_paused_sequencer_down`) when uptime feed says the sequencer is down.
- Resolved Aave addresses are cached at `.cache/aave-addresses.json` and injected into chain registry entries (`getResolvedAave`).

### Dry-run and benchmark commands

```bash
# Flash-wrapped dry-run replay (must produce profitable simulations)
npm run start:sim -- --dry-run

# Base latency + EV benchmark replay harness
npm run benchmark:base
```

### Production notes (must read)

- Public RPCs are not for production.
- No Flashbots on Base — direct sequencer + provider private-tx.
- Flash-loan wrapper mandatory.

---

## Observability

- **Logging** — Structured **JSON logs** via **Pino** (`createLogger` in `src/bot.ts`). Set `LOG_LEVEL` to control verbosity.
- **Metrics** — HTTP server (default port **9090**):
  - `http://localhost:9090/metrics` — Prometheus scrape endpoint (includes default Node metrics via `prom-client`).
  - `http://localhost:9090/healthz` — JSON health check; includes `bootstrapSource` / `usersSeeded` when bootstrap completes.
  - `http://localhost:9090/status` — Live dashboard / MCP poll target with `bootstrapSource`, `usersSeeded`, `positionCacheSize`, `bootstrapCacheHit`.
- **Grafana / alerts** — Helper definitions live in `src/production/productionReadiness.ts` (`createGrafanaDashboardDefinition`, PagerDuty-oriented alert shapes) for you to export into your monitoring stack.

---

## Memory limits (production)

A prior Base session exited near **920 MB RSS / 725 MB heap** under unbounded dedupe growth. Production targets:

| Setting | Value | Rationale |
| --- | --- | --- |
| `NODE_OPTIONS` | `--max-old-space-size=650 --expose-gc` | Caps V8 heap so emergency GC runs before the container OOM killer |
| Docker `mem_limit` | `1100m` | ~450 MB headroom for non-heap RSS (libuv, WS buffers, Prometheus, native addons) |
| In-process ceiling | ~90% of parsed heap (`nodeHeapLimits.ts`) | `memory_ceiling_hit` triggers graceful restart before hard kill |

**Derivation:** 650 MB heap + ~270 MB non-heap at prior incident ≈ 920 MB; 1100 MB container leaves margin after dedupe LRU (1k keys), cache `.size()` counter (no `listSnapshots().length`), and bounded watchlist TTL.

Set in: `Dockerfile`, `docker-compose.yml`, `ecosystem.config.cjs`, `scripts/launcher-run-bot*.cmd`, or `NODE_OPTIONS` in `.env`.

**Post-deploy diagnostics:** send `SIGUSR2` at T+0h, T+2h, T+4h (heap snapshots under `.runtime/`). Compare retained constructors in Chrome DevTools. Record RSS slope via `node scripts/audit-session.mjs`. See [docs/VALIDATION_RUNBOOK.md](docs/VALIDATION_RUNBOOK.md).

**Rust NAPI:** keep `RUST_HOTPATH_ENABLED=false` until [docs/rust-hotpath-promotion.md](docs/rust-hotpath-promotion.md) is complete.

---

## Safety checklist

1. **Never** use your main wallet; use a **new** hot wallet with **minimal** ETH for gas.
2. **Never** commit `.env` or share private keys / RPC URLs in chat or screenshots.
3. Keep `**SIMULATION_MODE=true`** until you understand every log line you care about.
4. **Live mode** requires a **valid dry-run receipt** matching current config — do not bypass unless debugging locally; fix the gate `reasons` instead.
5. **Stop** the bot with **Ctrl+C**; shutdown logs include cumulative profit snapshot from metrics.

---

## Project layout

```text
src/
├── index.ts              # Entry point: env parse, safety gate, bot wiring
├── bot.ts                # LiquidationBot loop, Pino logger, metrics HTTP server
├── config/               # chains.ts, chainRegistry.ts (registry for multi-chain apps)
├── protocols/aaveV3.ts     # Pool calls, liquidation params, subgraph queries
├── monitors/             # healthFactorMonitor, hybridDetectionPipeline, reserveAwareBorrowerCache
├── executors/            # liquidationExecutor, nonceManager, safeTransactionExecutor
├── profitability/        # profitabilityEngine, flashLoanProviderRouter
├── orchestrator/         # pipelineOrchestrator, dead-letter patterns
├── optimization/         # hazardPrediction (Bayesian / ranking helpers)
├── production/           # deployment gate, hot reload, shutdown, Grafana/PagerDuty helpers
└── utils/                # evCalculator, typedAssetMath, failover provider, telegram
test/
├── unit/                 # Fast unit tests
└── integration/          # Chaos / integration scenarios
```

---

## Verification

```bash
npm test
npm run typecheck
npm run build
```

---

## Adding or switching chains

- Set `CHAIN=arbitrum` **or** include `arbitrum` in `CHAINS` and ensure **RPC** + **subgraph** (or Graph key) target **Arbitrum** Aave V3.
- Confirm addresses and market parameters in `src/config/chains.ts` match the deployment you intend to use.

---

## Troubleshooting (beginners)

- **“Configure subgraph access…”** — Set `AAVE_SUBGRAPH_URL`, or `THE_GRAPH_API_KEY`, or for Base `BASE_AAVE_SUBGRAPH_URL` (or a combination that covers each chain in `CHAINS`).
- **Startup error mentioning `api.v3.aave.com` or `positions`** — `https://api.v3.aave.com/graphql` is the [AaveKit GraphQL](https://aave.com/docs/aave-v3/getting-started/graphql) product API (markets, `userBorrows`, etc.), not an indexer subgraph. Point `AAVE_SUBGRAPH_URL` at your chain’s Aave V3 subgraph (or use `THE_GRAPH_API_KEY`).
- **`auth error: API key not found` while using `BASE_AAVE_SUBGRAPH_URL`** — `AAVE_SUBGRAPH_URL` wins over `BASE_AAVE_SUBGRAPH_URL` when set (including a **machine-wide** or CI environment variable). Unset the global URL so Base uses your gateway URL, or put the same key in `AAVE_SUBGRAPH_URL`.
- **`THE_GRAPH_API_KEY`** must be **only** the gateway API key string (e.g. `cd30ae42…`), not a full `https://gateway.thegraph.com/api/...` URL. If you already use a full subgraph URL, set `AAVE_SUBGRAPH_URL` or `BASE_AAVE_SUBGRAPH_URL` to that URL and remove the mistaken `THE_GRAPH_API_KEY` value.
- `**deployment_safety_gate_blocked`** — You are in live mode without a valid dry-run receipt, margin, or chain registration. Read the `reasons` in the log.
- `**PRIVATE_KEY uses the placeholder…`** — Replace the sample key in `.env` for live mode.
- `**POLL_INTERVAL_MS must be exactly 400`** — Remove the variable to use default or set it to `400` only.

---

## License

See `package.json` (`license` field).