# Rust hot-path promotion checklist

The `rust-hotpath` NAPI module is **disabled in production** (`RUST_HOTPATH_ENABLED=false`). Do not enable until every item below is verified in staging.

## Safety

- [ ] Every `#[napi]` export wraps the body in `std::panic::catch_unwind` and maps panics to `napi::Error` (no process abort).
- [ ] Intentional panic test in staging: Node process **survives** and returns a structured error to JS.
- [ ] `RUST_HOTPATH_ENABLED` is the **only** gate that loads `index.node`; default `false` in Dockerfile, docker-compose, and `.env.example`.

## Performance evidence

- [ ] Benchmark on Base testnet under load shows measurable latency reduction on the **specific** hot-path (e.g. margin bps / path scoring), not theoretical.
- [ ] Regression test compares native vs `quickMarginBpsJs` for a fixed fixture set.

## Build & deploy

- [ ] CI prebuilds `index.node` for **linux x64** (deploy target); no `cargo build` on container start.
- [ ] Missing binary fails gracefully (JS fallback), not at `require()` during module load when flag is false.

## Operational

- [ ] Document rollback: set `RUST_HOTPATH_ENABLED=false` and redeploy (no code change).
- [ ] Metrics distinguish `rust_hotpath` vs `js_fallback` code paths.
