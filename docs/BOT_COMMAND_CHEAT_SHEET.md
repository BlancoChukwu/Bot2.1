# Aave V3 Liquidator — Command Cheat Sheet

**Repo:** `optimism-aave-v3-liquidator-ts` · **Chain focus:** Base · **Stack:** Event-purity (Flashblocks WS + oracle bootstrap + shadow validator)

---

## Current VM startup sequence (recommended)

Use this flow on Ubuntu/Linux VM. Legacy orchestrator launchers are listed later for reference only.

### One-time setup

| Step | Command |
|------|---------|
| 1. Enter repo | `cd ~/optimism-aave-v3-liquidator-ts` *(adjust path)* |
| 2. Install deps | `npm install` |
| 3. Create env profiles | `npm run env:bootstrap` |
| 4. Sync new keys from template | `npm run env:merge-example -- --target .env.event-purity-soak` |
| | `npm run env:merge-example -- --target .env.event-purity-production` |
| | `npm run env:sync-receiver-v5` |
| 5. Make launchers executable | `chmod +x start-*.sh watch-bot.sh scripts/launcher-run-bot-detached.sh` |
| 6. Edit secrets | Edit `.env.event-purity-soak` and `.env.event-purity-production` (RPC, wallet, WS URLs) |

### Before first live run

| Step | Command | Notes |
|------|---------|-------|
| A. 48h shadow soak | `./start-event-purity-soak.sh` | `SIMULATION_MODE=true`, no live TX |
| B. Monitor soak | `./watch-bot.sh` | Ctrl+C to exit; use `--once` for snapshot |
| C. Dry-run receipt (live only) | `npm run dry-run:receipt:event-purity-production` | Required for safety gate |
| D. Start live within 15 min | `./start-event-purity-production.sh` | Receipt TTL ~15 minutes |

### What each start script does internally

1. `npm run bot:stop` — stop any running instance  
2. `node scripts/ensure-redis.mjs` — local Redis for block cursor  
3. `npm run build` — compile TypeScript → `dist/`  
4. `node scripts/preflight-event-purity-env.mjs` — validate WS + Flashblocks env  
5. `scripts/launcher-run-bot-detached.sh` — **detached** `nohup` process + session log metadata  

Logs: `logs/<prefix>-YYYYMMDD-HHMMSS.log` · Session pointer: `logs/latest-session.txt`

### Day-to-day ops

| Action | Command |
|--------|---------|
| Monitor (refresh 30s) | `./watch-bot.sh` |
| Single status snapshot | `./watch-bot.sh --once` |
| Full audit in monitor | `./watch-bot.sh --audit` |
| Tail active log | `tail -f logs/event-purity-production-*.log` *(or path from `latest-session.txt`)* |
| Bot process status | `npm run bot:status` |
| Stop bot | `npm run bot:stop` |
| HTTP health | `curl -s http://127.0.0.1:9090/healthz` |
| HTTP status JSON | `curl -s http://127.0.0.1:9090/status` |
| Prometheus metrics | `curl -s http://127.0.0.1:9090/metrics` |

---

## VM shell launchers (Ubuntu/Linux)

| Command | Env profile | Mode |
|---------|-------------|------|
| `./start-event-purity-soak.sh` | `.env.event-purity-soak` | **Recommended soak** — shadow, no live TX |
| `./start-event-purity-production.sh` | `.env.event-purity-production` | **Recommended live** — safety gate ON |
| `./start-simulation.sh` | `.env.simulation` | Legacy soak (poll/orchestrator) |
| `./start-production.sh` | `.env.production` | Legacy live (standard RPC) |
| `./start-production-budget.sh` | `.env.production.budget` | Legacy live (`RPC_BUDGET_MODE=true`) |
| `./watch-bot.sh` | — | Live monitor dashboard |
| `./watch-bot.sh --once` | — | One-shot status |
| `./watch-bot.sh --audit` | — | Monitor + full session audit |
| `./watch-bot.sh --interval 10` | — | Refresh every 10s |
| `./watch-bot.sh --log path/to.log` | — | Point at specific log file |

---

## Windows desktop launchers (.cmd)

| File | Purpose |
|------|---------|
| `Start Event-Purity Soak.cmd` | 48h event-purity soak |
| `Start Event-Purity Production.cmd` | Event-purity live |
| `Start Simulation Bot.cmd` | Legacy simulation |
| `Start Production Bot.cmd` | Legacy live |
| `Start Production Bot (Budget).cmd` | Legacy live, RPC budget |
| `Start Production Bot (No Gate).cmd` | Legacy live, skips safety gate |
| `Start Live Bot.cmd` | `npm run start:live` (ts-node, foreground) |
| `Stop Bot.cmd` | Stop via single-instance lock |
| `Setup Dry Run Receipt.cmd` | Dry-run receipt helper |

---

## npm scripts — bot lifecycle

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript |
| `npm run start` | Run compiled bot (`node dist/src/index.js`) |
| `npm run dev` | Run via ts-node (dev) |
| `npm run start:sim` | Foreground sim (`ts-node`, uses `.env`) |
| `npm run start:live` | Foreground live (`SIMULATION_MODE=false`) |
| `npm run bot:status` | JSON status of lock + bot PIDs |
| `npm run bot:stop` | Graceful stop via single-instance lock |
| `npm run redis:ensure` | Start/verify local Redis |

---

## npm scripts — environment profiles

| Command | Purpose |
|---------|---------|
| `npm run env:bootstrap` | Create `.env.production`, `.env.simulation`, event-purity profiles |
| `npm run env:merge-example` | Merge `.env.example` keys into target profile |
| `npm run dry-run:receipt` | Dry-run receipt for legacy `.env.production` |
| `npm run dry-run:receipt:event-purity-production` | Dry-run receipt for event-purity live |

**Merge example (dry-run preview):**

`node scripts/merge-env-from-example.mjs --target .env.event-purity-production --dry-run`

---

## npm scripts — testing & typecheck

| Command | Purpose |
|---------|---------|
| `npm test` | All unit tests (vitest) |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:coverage` | Coverage report |
| `npm run test:chaos` | Chaos integration tests only |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:flashblocks` | Flashblocks WS connection probe |

---

## npm scripts — validation & benchmarks

| Command | Purpose |
|---------|---------|
| `npm run verify:pre-soak-phase0` | Pre-soak phase-0 verification |
| `npm run benchmark:base` | Base replay benchmark |
| `npm run benchmark:rpc` | RPC latency benchmark → `.runtime/rpc-benchmark.json` |
| `npm run check:rpc-gates` | Check RPC benchmark SLO gates |
| `npm run probe:multicall-base` | Multicall batch probe on Base |
| `npm run debug:hf-sweep-base` | Debug HF sweep on Base |
| `npm run replay:historical` | Historical replay script |
| `npm run replay:liquidation-block` | Replay specific liquidation block |

---

## npm scripts — audits & reports

| Command | Purpose |
|---------|---------|
| `npm run audit:watchlist-base` | Audit Base watchlist coverage |
| `npm run audit:dex-surface-base` | Audit DEX surface on Base |
| `npm run audit:morpho-preliquidation-base` | Morpho pre-liquidation audit |
| `npm run report:competitive-gap` | Competitive gap report (48h default) |
| `npm run review:daily-pipeline` | Daily pipeline review |
| `npm run pairs:top-base` | Select top Base trading pairs |

---

## npm scripts — build, contracts & deploy

| Command | Purpose |
|---------|---------|
| `npm run compile:contracts` | Compile liquidation receiver Solidity |
| `npm run deploy:liquidation-receiver:base` | Deploy receiver on Base |
| `npm run rust:build` | Build rust-hotpath (`cargo build --release`) |

---

## Direct node scripts (ops & diagnostics)

| Command | Purpose |
|---------|---------|
| `node scripts/ensure-single-bot.mjs --status` | Same as `npm run bot:status` |
| `node scripts/ensure-single-bot.mjs --stop` | Same as `npm run bot:stop` |
| `node scripts/ensure-redis.mjs` | Ensure Redis running |
| `node scripts/preflight-event-purity-env.mjs .env.event-purity-production` | Env preflight check |
| `node scripts/verify-bot-launch.mjs logs/<file>.log` | Verify bot started in log |
| `node scripts/audit-session.mjs logs/<file>.log` | Full session audit report |
| `node scripts/watch-bot-summary.mjs logs/<file>.log` | Session summary stats |
| `node scripts/detect-critical-log-errors.mjs logs/<file>.log` | Scan for critical errors |
| `node scripts/soak-production-report.mjs` | Soak production report |
| `node scripts/secret-scan.mjs` | Scan for leaked secrets |
| `node scripts/bootstrap-env-profiles.mjs` | Same as `npm run env:bootstrap` |

---

## Optional: PM2 (alternative to detached launcher)

| Command | Purpose |
|---------|---------|
| `pm2 start ecosystem.config.cjs` | Start via PM2 |
| `pm2 logs aave-liquidator-base` | Tail PM2 logs |
| `pm2 stop aave-liquidator-base` | Stop PM2 app |
| `pm2 restart aave-liquidator-base` | Restart |

*Note: VM launchers use `launcher-run-bot-detached.sh` + single-instance lock by default.*

---

## Environment profiles reference

| File | Use with |
|------|----------|
| `.env.event-purity-soak` | `./start-event-purity-soak.sh` |
| `.env.event-purity-production` | `./start-event-purity-production.sh` |
| `.env.simulation` | `./start-simulation.sh` |
| `.env.production` | `./start-production.sh` |
| `.env.production.budget` | `./start-production-budget.sh` |

---

## Quick troubleshooting

| Symptom | Check |
|---------|-------|
| Live start blocked | `deployment_safety_gate_blocked` in log — run dry-run receipt, start within 15 min |
| Missing profile | `npm run env:bootstrap` |
| WS / Flashblocks fail | `npm run test:flashblocks` + preflight script |
| Multiple bots | `npm run bot:status` then `npm run bot:stop` |
| Oracle bootstrap fatal | `SEQUENCER_DOWN_OR_IN_GRACE_PERIOD` — sequencer feed unhealthy |
| Stale lock file | Removed automatically on next start via single-instance lock |

---

*Generated for VM quick reference. See `docs/ENV_PROFILES.md` and `README.md` for full detail.*
