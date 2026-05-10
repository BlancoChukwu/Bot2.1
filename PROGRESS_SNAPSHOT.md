# Progress snapshot

**Date:** 2026-05-10 (local workspace)

## Shipped in this session / branch

- **Base Aave V3:** Pool / PoolAddressesProvider / UI pool data provider aligned with [bgd-labs aave-address-book](https://github.com/bgd-labs/aave-address-book) (`AaveV3Base`); Optimism/Arbitrum keep shared addresses.
- **Subgraph:** `BASE_AAVE_SUBGRAPH_URL` + per-chain `aaveSubgraphByChain`; `users` fallback when subgraph has no Messari-style `positions`; reject AaveKit `api.v3.aave.com` for borrower paging.
- **`npm run start`:** Entry `dist/src/index.js` (matches `tsc` outDir layout).
- **`MIN_PROFIT_MARGIN_BPS`:** Floor **40 bps** in simulation, **50 bps** in live; deployment gate matches mode.
- **`ArbitrageScanner`:** Uses `config.minProfitMarginBps` (no hardcoded 120 in pipeline bot).
- **Observability:** `arbitrage_quote_debug` after each successful QuoterV2 / `getAmountsOut` quote (amounts + route metadata).
- **Docs / `.env.example`:** Base RPC pattern, subgraph troubleshooting, `USE_PIPELINE_ORCHESTRATOR`.

## Next (ops)

- Set `ARBITRAGE_RECEIVER_ADDRESS` for arb execution plans.
- Raise `MIN_PROFIT_MARGIN_BPS` to 80–120 before narrow live runs; keep `SIMULATION_MODE=true` until dry-run + gates pass.

This file is intentional local/history context; rotate or trim if you prefer a slimmer repo.
