# RPC Provider Lock (Base)

This document locks the production RPC layout for the Base liquidation stack and defines how to validate it before shadow/live sessions.

## Provider mapping

### Standard (paid QuickNode Flashblocks)

- Primary execution RPC: `EXECUTION_RPC_URL_PRIMARY` (Alchemy)
- Execution failover RPCs: `EXECUTION_RPC_URL_FALLBACKS` (Chainstack first)
- WS primary (detection): `WS_RPC_URL_PRIMARY` (QuickNode Flashblocks WSS)
- WS secondary (detection): `WS_RPC_URL_SECONDARY` (Alchemy)
- WS tertiary (detection): `WS_RPC_URL_TERTIARY` (backup provider)
- Flashblocks endpoint: `FLASHBLOCKS_RPC_URL` (Flashblocks-capable QuickNode or Alchemy URL)

### Budget / no QuickNode (event-purity soak, quota-limited)

When QuickNode is unavailable, use **Alchemy + Chainstack + NodeReal/Infura/dRPC/GetBlock** with budget mode:

- `RPC_BUDGET_MODE=true` — enables graceful WS subscribe (skip unsupported subs, 15s timeout) and relaxed gates
- `WS_RPC_URL_PRIMARY` — Chainstack or Alchemy WSS (whichever subscribes reliably in your benchmark)
- `WS_RPC_URL_SECONDARY` — the other provider
- `WS_INGESTION_GRACEFUL=true` — optional explicit override (also set by `RPC_BUDGET_MODE`)

Graceful ingestion fallbacks (tried in order; failures are skipped, not fatal):

| Role | Preferred | Fallback |
| --- | --- | --- |
| Pool events | `pendingLogs` | confirmed `logs` on pool address |
| Block clock | `newFlashblocks` | `newHeads` |

At least one ingestion + one clock subscription must succeed or startup fails with a clear error.

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
