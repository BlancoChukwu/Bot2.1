# Chain-Agnostic Aave V3 Liquidator

TypeScript Node.js liquidation bot for Aave V3 with Optimism enabled first and Arbitrum-ready chain configuration.

## What It Does

- Polls the configured Aave V3 market every `400ms`.
- Discovers borrower accounts through the configured Aave V3 subgraph, then rechecks health on-chain through `viem`.
- Reads health factor data through `viem`.
- Builds liquidation candidates when health factor is below `1.0`.
- Applies EV checks before execution.
- Starts in `SIMULATION_MODE=true` by default.
- Simulates every liquidation before sending when live execution is enabled.
- Sends Aave V3 `liquidationCall` transactions through a `viem` wallet client.
- Exposes Aave `flashLoanSimple` call parameter construction for receiver-contract based flash-loan execution.
- Sends optional Telegram alerts for simulated and executed liquidations.
- Exposes Prometheus metrics at `http://localhost:9090/metrics`.
- Logs structured JSON through `winston`.
- Registers default process metrics through `prom-client`.

## Safety Notes

This bot is intentionally chain-agnostic, but only Optimism is ready for active use. Arbitrum is present in `src/config/chains.ts` so the engine can support it later without rework.

The scanner needs a working **Aave V3 subgraph** for broad borrower discovery. The old hosted `api.thegraph.com/subgraphs/name/...` URLs are gone; use The Graph **Gateway** with an API key or any compatible GraphQL URL. Set `AAVE_SUBGRAPH_URL` to the full endpoint, or set `THE_GRAPH_API_KEY` (free from The Graph) and leave `AAVE_SUBGRAPH_URL` empty to use the default subgraph ID for your `CHAIN`. Health factors are still checked on-chain before candidates are emitted.

WARNING: Never use your main wallet. Create a fresh hot wallet and fund it with only about `$20-50` worth of ETH for Optimism gas. Assume any private key placed in `.env` can be lost. Keep `SIMULATION_MODE=true` until you have reviewed logs, RPC behavior, and gas estimates.

## Beginner Quick Start

```bash
cp .env.example .env
```

1. Copy `.env.example` to `.env`.
2. Add your Optimism RPC URL, subgraph (`AAVE_SUBGRAPH_URL` or `THE_GRAPH_API_KEY`), and a fresh hot wallet private key to `.env`.
3. Run `npm install`.
4. Run `npm run start:sim`.
5. Watch the logs for simulated liquidations.
6. When ready, change `SIMULATION_MODE=false` in `.env` and restart, or run `npm run start:live`.

Stop the bot safely with `Ctrl+C`. The bot handles shutdown and logs total tracked profit before exiting.

## Required Environment

- `CHAIN`: `optimism` by default; `arbitrum` is accepted for future extension.
- `RPC_URL`: primary RPC endpoint.
- `FALLBACK_RPC_URLS`: optional comma-separated fallback endpoints.
- `WS_RPC_URL`: optional WebSocket RPC endpoint for `ReserveDataUpdated` subscriptions.
- `AAVE_SUBGRAPH_URL`: full GraphQL URL for the Aave V3 subgraph (e.g. `https://gateway.thegraph.com/api/<KEY>/subgraphs/id/<ID>`). Optional if `THE_GRAPH_API_KEY` is set.
- `THE_GRAPH_API_KEY`: optional; when set and `AAVE_SUBGRAPH_URL` is empty, the bot uses the default Aave V3 subgraph ID for the selected `CHAIN` on The Graph Gateway.
- `PRIVATE_KEY`: liquidator hot-wallet private key. Never use your main wallet.
- `SIMULATION_MODE`: defaults to `true`; when true, the bot simulates but never sends real transactions.
- `POLL_INTERVAL_MS`: exactly `400`.
- `CANDIDATE_COOLDOWN_MS`: duplicate candidate suppression window.
- `MIN_PROFIT_THRESHOLD_ETH`: minimum positive EV threshold, defaults to `0.01`.
- `MIN_PROFIT_USD`: minimum EV threshold before simulation.
- `GAS_COST_USD`: conservative gas estimate used in EV checks.
- `SLIPPAGE_BPS`: safety haircut in basis points.
- `TELEGRAM_BOT_TOKEN`: optional alert bot token.
- `TELEGRAM_CHAT_ID`: optional alert destination.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.

## Beginner Safety Checklist

1. Never use your main wallet.
2. Start with `SIMULATION_MODE=true`.
3. Use a fresh hot wallet with only `$20-50` ETH max for gas.
4. Review `SIMULATED liquidation of ...` logs before setting `SIMULATION_MODE=false`.
5. Keep private RPC and wallet secrets out of screenshots, commits, and chat.

## Runtime Commands

```bash
npm run start:sim
npm run start:live
```

`start:sim` is the default safe mode. `start:live` overrides `SIMULATION_MODE=false` and can send real transactions.

Prometheus metrics are available at:

```text
http://localhost:9090/metrics
```

## Project Layout

```text
src/
├── config/chains.ts
├── protocols/aaveV3.ts
├── monitors/healthFactorMonitor.ts
├── utils/evCalculator.ts
├── executors/liquidationExecutor.ts
├── utils/failoverProvider.ts
├── bot.ts
├── index.ts
```

## Verification

```bash
npm test
npm run typecheck
npm run build
```

## Adding Arbitrum

Change `CHAIN=arbitrum`, confirm the Arbitrum Aave V3 reserve config in `src/config/chains.ts`, and use Arbitrum RPC/subgraph URLs.
