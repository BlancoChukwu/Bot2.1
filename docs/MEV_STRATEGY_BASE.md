# Base Aave V3 Liquidator — MEV Strategy (2026)

## Decision framework

| Strategy | When to use | Margin floor |
|----------|-------------|--------------|
| **A: Public mempool + aggressive gas** | Default; private relay unavailable or `latency_delta_ms ≥ 500` | `MIN_PROFIT_MARGIN_BPS ≥ 75` |
| **B: Private builder/relay** | `test-mev-relay-latency.mjs` shows `latency_delta_ms < 500` | −10 bps vs Strategy A |

## Mandatory binary test

```bash
node scripts/test-mev-relay-latency.mjs --public-rpc "$EXECUTION_RPC_URL_PRIMARY" --private-rpc "$PRIVATE_TX_RPC_URL"
```

Record `t_public_ms`, `t_private_ms`, and `latency_delta_ms` in the dry-run receipt before `ENABLE_LIVE_TX=true`.

## Profit gate (low capital)

- Live `MIN_PROFIT_MARGIN_BPS`: **75** until 10 successful liquidations
- Gas buffer: `estimateLiquidationGasCostUsd` uses **1.5×** gas units
- First live week: reject `debtUsd < 500`
- Failed competitive txs: budget **2–3 failed txs/day** in backtest EV

## On-chain race protection

`LiquidationFlashReceiver` V2 (`RECEIVER_VERSION=2`) asserts `getUserAccountData(user).healthFactor < 1e18` before `liquidationCall`.

Off-chain: `safeTransactionExecutor` rejects broadcast when HF ≥ 1.0 or detection block is stale by >1 block.

## Live enablement checklist

1. `scripts/audit-unconfirmed-tier-positions.mjs` → `unconfirmed_urgent_watch_count = 0`
2. Receiver V2 deployed; `assertLiquidationReceiverReadiness` passes
3. `replay-base-liquidations.mjs` recall gates on ≥20 events (30d)
4. MEV strategy signed off in this doc
