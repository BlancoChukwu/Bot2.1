# VPS Baseline (Phase 0.2)

This checklist confirms the runtime host baseline before latency benchmarks and shadow runs.

## Region and host

- Provider: AWS
- Region: `us-east-1`
- Host clock synchronized (NTP/Chrony)

## Required runtime checks

- App process runs from this repository path
- Prometheus endpoint reachable on `http://127.0.0.1:9090/metrics`
- Node memory cap configured as documented in `README.md`

## Benchmark workflow

1. Load production-like `.env` values with real provider URLs.
2. Run:
   - `npm run benchmark:rpc`
   - `npm run test:flashblocks`
3. Archive `.runtime/rpc-benchmark.json` and `.runtime/flashblocks-test.json` with timestamp.

## Rollback baseline

- Keep previous provider values ready in secure ops config.
- If benchmark/SLO degrades, roll back to prior provider ordering and rerun benchmarks before resuming shadow/live sessions.

