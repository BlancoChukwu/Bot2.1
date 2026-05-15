---
name: FTRL Provider Scoring Upgrade
overview: Implement a production-grade, no-regret provider scorer for MultiWs with adaptive learning rates, hazard fusion, regret observability, and benchmark/test coverage, while minimizing disruption to existing pipeline behavior.
todos:
  - id: define-scorer-contract
    content: Create FTRL provider scorer interface/module and config schema
    status: pending
  - id: implement-ftrl-core
    content: Implement 1/2-Tsallis BOBW update + exact SPM eta + regret accounting
    status: pending
  - id: integrate-multiws
    content: Wire scorer into MultiWs handlers and ranking/selection path with feature flag
    status: pending
  - id: add-metrics
    content: Add provider regret/weights/loss metrics and structured diagnostics
    status: pending
  - id: extend-benchmark
    content: Add static/heuristic/ftrl benchmark arms and acceptance gates
    status: pending
  - id: tests-and-coverage
    content: Add scorer + integration tests and enforce >=90% per-file coverage
    status: pending
isProject: false
---

# Production FTRL Provider Scoring Plan (Revised)

## Assumptions (explicit and constrained)
- Ship as **feature-flagged rollout** (default OFF in production, ON in benchmarks/tests).
- Scope is **provider scoring only** in MultiWs for this phase; do not touch opportunity ranking behavior.
- Keep current behavior available as fallback for safe rollback.
- Use the exact SPM rule and accumulator definitions from internal FTRL reference doc + attached formula image during implementation (no surrogate schedule).

## Locked Defaults (ship these first)
- **Regularizer mode:** `tsallis_half` (q = 1/2), no hybrid mode in phase 1.
- **Learning-rate defaults:** `eta_init = 0.08`, `eta_min = 0.005`, `eta_max = 0.35`, `eta_warmup_floor = 0.03` for first `warmup_events = 200`.
- **SPM accumulators:** initialize `z_0 = 1`, `h_0 = 1`; update every event from observed loss vector before next-round distribution.
- **Exploration policy:** epsilon-greedy on simplex with deterministic RNG seed.
- **Exploration schedule:** `epsilon_start = 0.12`, `epsilon_end = 0.02`, exponential decay over `decay_events = 3000`.
- **Rollout defaults:** `FTRL_PROVIDER_SCORING_ENABLED = false`; `FTRL_ROLLOUT_PCT = 10` for first canary stage.
- **Rollout ladder:** `10 -> 25 -> 50 -> 100` after benchmark gate + canary stability at each stage.
- **Circuit breaker defaults:** trigger fallback when `cumulative_regret_ftrl > 2.0 * cumulative_regret_best_fixed` for `N = 250` consecutive events.
- **Warm-start cache:** path `cache/ftrl-provider-scorer-state.json`, save every `save_every_events = 50`, atomic write + schema version guard.
- **Loss weights:** `w_latency = 0.30`, `w_missed_ev = 0.40`, `w_getlogs = 0.10`, `w_flashblocks = 0.10`, `w_error = 0.10`, `w_hazard = 0.15` (hazard additive, tuned separately).
- **Error severity multipliers:** transient `1.0`, repeated `1.5`, outage/disconnect `3.0`.
- **Normalization defaults:** bounded sigmoid for latency/getLogs/error terms; online min-max for EV-missed and flashblocks lead penalty.

## Scope
- Replace heuristic `ftrlBoost`-style ranking with a dedicated `FTRLProviderScorer` supporting:
  - cumulative loss vector updates,
  - **1/2-Tsallis** regularized action weighting (BOBW-oriented),
  - **exact SPM adaptive eta update** (not hooks/scaffold),
  - hazard signal fusion from Bayesian hazard estimates,
  - explicit regret tracking vs best-fixed-provider baseline.
- Wire scorer into MultiWs event/error/latency/flashblock feedback loop.
- Add bot-level metrics + benchmark arms for `static` vs `heuristic` vs `ftrl`.
- Add/extend tests to enforce >=90% coverage for new scorer module.

## Implementation Steps
1. **Define provider scorer interface and config contract**
   - Add a new scorer module at [src/monitors/FTRLProviderScorer.ts](src/monitors/FTRLProviderScorer.ts).
   - Expose deterministic methods: `updateFromEvent`, `updateFromError`, `updateFromLatency`, `rankProviders`, `samplePrimary`, `getDiagnostics`.
   - Include typed loss weights, learning params, hazard fusion mode, exploration config, rollout config, and replay seed.

2. **Implement no-regret core with 1/2-Tsallis + exact SPM**
   - Track per-provider cumulative loss and per-round diagnostics (loss, probability, chosen action).
   - Implement **1/2-Tsallis** update path (O(K) per round for small K).
   - Implement exact SPM schedule:
     - `eta_t = eta_(t-1) * (2 / (1 + sqrt(1 + 4 * z_t * eta_(t-1)^2 / h_t)))`
     - `z_t`, `h_t` are updated each round from observed losses per the referenced SPM closed form.
   - Add warmup floor + min/max eta clamps using locked defaults.
   - Implement best-fixed-provider regret computation online.

3. **Economically calibrate and normalize loss vector**
   - Compute EV-aware loss components:
     - `missed_opp_loss = missed_opps_k * estimated_EV_of_missed_liquidation`.
     - latency loss normalized online (quantile/variance-aware scaling) with EV sensitivity.
     - error-rate loss scaled by severity class (outage > transient failure).
   - Normalize each component to bounded values (`[0,1]`) via online min-max/sigmoid for numerical stability.
   - Keep weighted sum configurable, with defaults aligned to current telemetry coverage.

4. **Fuse Bayesian hazard as prior + additive term**
   - Initialize provider priors from hazard estimates (weight/probability prior).
   - Add hazard-derived risk as additive calibrated loss term with configurable `w_hazard`.
   - Preserve existing per-provider signals already collected in [src/monitors/MultiWsEventSource.ts](src/monitors/MultiWsEventSource.ts):
     - `event_to_detection_ms`, `missed_opps`, `eth_getLogs latency`, `flashblocks_lead_ms`, error rate.

5. **Integrate scorer into MultiWs selection/ranking path**
   - Refactor [src/monitors/MultiWsEventSource.ts](src/monitors/MultiWsEventSource.ts) to call scorer updates in event, error, and flashblock handlers.
   - Add controlled exploration in `samplePrimary` using locked epsilon-greedy schedule + deterministic seed for replay reproducibility.
   - Add `FTRL_ROLLOUT_PCT` rollout gate (event-level probabilistic selection between legacy and FTRL path) using locked rollout ladder.
   - Replace direct `score` sorting as source-of-truth when rollout path selects FTRL; keep legacy score telemetry for side-by-side comparison.
   - Keep provider state minimal; move ranking policy logic out of `MultiWsEventSource`.

6. **Expose observability and regret diagnostics**
   - Extend [src/bot.ts](src/bot.ts) metric set with:
     - instantaneous and cumulative regret vs best-fixed baseline,
     - cumulative regret vs best-hindsight-per-signal baseline,
     - per-provider probability/weight gauges,
     - regret-decomposition histograms (latency vs hazard vs EV-miss),
     - per-signal normalized loss histograms,
     - selected-provider counters by mode.
   - Log structured diagnostics in `multi_ws_provider_ranking` records for auditability.

7. **Benchmark extension with drift hardening**
   - Extend [test/integration/benchmark.replay.ts](test/integration/benchmark.replay.ts) with 3 arms:
     - static ordering,
     - current heuristic,
     - new FTRL scorer.
   - Add synthetic drift injection scenarios (provider latency x2 windows, intermittent outages, congestion spikes).
   - Report p50/p95 detection latency, missed opportunities, cumulative regret, and winner-distribution table.
   - Add acceptance gates: no latency regression under drift and FTRL cumulative regret <= best-fixed baseline across scenarios.

8. **Test-first validation and coverage gate**
   - Add unit tests for new scorer: exact weight evolution on deterministic loss traces, normalization, eta adaptation boundaries, regret accounting, deterministic ranking/sampling.
   - Add small-T regret sanity checks against expected asymptotic trend (`O(sqrt(T log K))` envelope) on controlled sequences.
   - Add edge-case tests: all providers equal, permanent outage of one provider, sudden drift regime change.
   - Update [test/unit/multiWsEventSource.test.ts](test/unit/multiWsEventSource.test.ts) for integration behavior under feature flags.
   - Keep [test/unit/hazardPrediction.test.ts](test/unit/hazardPrediction.test.ts) changes minimal and only for shared utility reuse (no opportunity-ranking behavior edits).
   - Update [vitest.config.ts](vitest.config.ts) `coverage.include` to include the new scorer file and satisfy per-file >=90% thresholds.

9. **Production rollout safety**
   - Default feature flag OFF.
   - Gradual rollout via locked `FTRL_ROLLOUT_PCT` ladder (`10 -> 25 -> 50 -> 100`) after benchmark + canary checks.
   - Add circuit breaker with locked trigger (`>2x` best-fixed for `N=250` consecutive events) and auto-fallback to legacy mode.
   - Warm-start scorer state from locked JSON cache path (weights, losses, eta state), with safe reset on schema mismatch.

## Design Boundaries (to avoid overreach)
- Do not redesign pipeline orchestrator ranking semantics in this phase.
- Do not remove legacy heuristic path until benchmark + replay evidence passes gates.
- Keep computational overhead O(K) with K≈3 providers.

## Verification Checklist
- `npm run test:unit` passes with scorer and MultiWs tests.
- Integration benchmark runs and prints comparative table for all 3 arms, including drift scenarios.
- Metrics endpoint includes new regret/weight series.
- Coverage report shows >=90% for `FTRLProviderScorer.ts`.
- Rollout safety checks validated: feature-flag OFF path, rollout percentage behavior, circuit-breaker fallback, and warm-start restore/reset.

## Follow-up Phase (immediately after this plan)
- Reuse the scorer core in opportunity ranking path in [src/optimization/hazardPrediction.ts](src/optimization/hazardPrediction.ts) and [src/index.ts](src/index.ts) to unify no-regret accounting across provider and opportunity layers.
