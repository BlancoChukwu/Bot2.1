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
- **Live mode** — The bot may **send real transactions** from your wallet. **Live startup is guarded** by a **deployment safety gate** (recent dry-run validation and margin thresholds). See [Simulation vs live](#simulation-vs-live).

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

**Windows:** you can also double-click `Start Live Bot.cmd`, which runs `npm run start:live`. It does **not** bypass safety gates.

### Live mode requirements (deployment safety gate)

When `SIMULATION_MODE=false`, startup **fails** unless **all** of the following are satisfied:

1. **At least one chain** is registered (`CHAIN` or `CHAINS`).
2. `**MIN_PROFIT_MARGIN_BPS`** is **≥ 20** (0.2% bootstrap floor for live and simulation).
If live startup is **blocked**, logs show `deployment_safety_gate_blocked` with a `reasons` array. Fix those before retrying.

**Optional:** `DRY_RUN_*` env vars and `npm run start:sim -- --dry-run` remain useful for manual validation; they are **not** enforced at live startup.

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
| `PAGERDUTY_ROUTING_KEY`                   | No       | Optional; for external Grafana/PagerDuty integrations (not enforced at startup).                                     |
| `DRY_RUN_*`                               | No       | Optional manual dry-run receipt helpers (`npm run apply-dry-run-receipt`); not enforced at startup.                  |


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

### Detection/scoring internals (what the bot does)

- `MultiWsEventSource` tracks provider quality with a Bayesian + FTRL ranking model and promotes endpoints with faster, cleaner event streams.
- When `FLASHBLOCKS_ENABLED=true`, block-driven `eth_getLogs` checks are sampled and reported as `flashblocks_lead_ms`.
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
  - `http://localhost:9090/healthz` — JSON `{"status":"ok"}` for load balancers or quick checks.
- **Grafana / alerts** — Helper definitions live in `src/production/productionReadiness.ts` (`createGrafanaDashboardDefinition`, PagerDuty-oriented alert shapes) for you to export into your monitoring stack.

---

## Safety checklist

1. **Never** use your main wallet; use a **new** hot wallet with **minimal** ETH for gas.
2. **Never** commit `.env`, `PRIVATE_KEY`, API keys, or bot tokens — only `.env.example*` templates belong in git. Run `npm run hooks:install` once so `pre-commit` blocks secrets; `npm run secret-scan` checks staged files manually.
3. Keep `**SIMULATION_MODE=true`** until you understand every log line you care about.
4. **Live mode** enforces chain registration, metrics, and **MIN_PROFIT_MARGIN_BPS** ≥ 20 — fix `deployment_safety_gate_blocked` reasons instead of bypassing checks.
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
- `**deployment_safety_gate_blocked`** — Live mode failed margin, chain, or metrics checks. Read the `reasons` in the log.
- `**PRIVATE_KEY uses the placeholder…`** — Replace the sample key in `.env` for live mode.
- `**POLL_INTERVAL_MS must be exactly 400`** — Remove the variable to use default or set it to `400` only.

---

## License

See `package.json` (`license` field).