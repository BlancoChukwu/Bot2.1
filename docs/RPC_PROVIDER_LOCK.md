# RPC Provider Lock (Base)

This document locks the production RPC layout for the Base liquidation stack and defines how to validate it before shadow/live sessions.

## Provider mapping

- Primary execution RPC: `EXECUTION_RPC_URL_PRIMARY` (Alchemy)
- Execution failover RPCs: `EXECUTION_RPC_URL_FALLBACKS` (Chainstack first)
- WS primary (detection): `WS_RPC_URL_PRIMARY` (QuickNode)
- WS secondary (detection): `WS_RPC_URL_SECONDARY` (Alchemy)
- WS tertiary (detection): `WS_RPC_URL_TERTIARY` (backup provider)
- Flashblocks endpoint: `FLASHBLOCKS_RPC_URL` (Flashblocks-capable QuickNode or Alchemy URL)

The baseline benchmark is run from a VPS in `us-east-1`, never from a local desktop.

## Required benchmark output

Run:

```bash
npm run benchmark:rpc
```

The script writes `.runtime/rpc-benchmark.json` with per-provider measurements:

- `newHeadsWsLatency`: p50/p95/p99 for block head notification latency
- `flashblockStream`: pending-log cadence and lead latency
- `ethCallRtt`: p50/p95/p99 for `getUserAccountData` contract reads

## Acceptance targets

- `newHeadsWsLatency.p95_ms < 50` on the locked primary/secondary path (standard)
- Flashblock cadence around the configured tick interval
- No persistent RPC call failures in `ethCallRtt`

Verify with:

```bash
npm run benchmark:rpc
npm run check:rpc-gates
```

**Quota-limited hosts:** set `RPC_BUDGET_MODE=true` in `.env` (see [RPC_BUDGET_PROFILE.md](./RPC_BUDGET_PROFILE.md)). Gates scale 2× (e.g. WS p95 &lt; **100** ms) and the bot applies ~50% lower steady-state RPC duty cycle.

If a provider fails targets, rotate it out before the 48h shadow window.

