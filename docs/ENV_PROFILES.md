# Environment profiles (VM / desktop)

Three gitignored env files drive one-command launchers. Never commit them.

| File | Launcher (Windows) | Launcher (Ubuntu) | Mode |
| --- | --- | --- | --- |
| `.env.simulation` | `Start Simulation Bot.cmd` | `./start-simulation.sh` | Legacy soak: poll/orchestrator profile |
| `.env.production` | `Start Production Bot.cmd` | `./start-production.sh` | Legacy live: standard RPC profile |
| `.env.production.budget` | `Start Production Bot (Budget).cmd` | `./start-production-budget.sh` | Legacy live: `RPC_BUDGET_MODE=true` |
| `.env.event-purity-soak` | `Start Event-Purity Soak.cmd` | `./start-event-purity-soak.sh` | **Event-purity 48h shadow soak** (Flashblocks WS, no live TX) |
| `.env.event-purity-production` | `Start Event-Purity Production.cmd` | `./start-event-purity-production.sh` | **Event-purity live** (`ENABLE_LIVE_TX=true`, safety gate ON) |

Legacy launchers are unchanged. Use the event-purity row for the new Flashblocks + bootstrap + shadow-validator stack.

## Sync keys from `.env.example`

When the template gains new variables or your profile files have drifted:

```bash
npm run env:merge-example
npm run env:bootstrap
```

`env:merge-example` walks `.env.example` line-by-line, keeps your existing values, adds missing keys (including commented defaults), and appends orphan keys from the target at the end. Default target is the first file found among `.env`, `.env.production`, `.env.simulation`; override with `--target .env` or `ENV_MERGE_TARGET`.

Preview without writing:

```bash
node scripts/merge-env-from-example.mjs --target .env.simulation --dry-run
```

## Bootstrap from current `.env`

```bash
npm run env:bootstrap
```

Copies RPC keys, wallet, receiver, FTRL, and dry-run receipt fields into `.env.production`, then derives simulation and budget variants.

## Dry-run receipt

Legacy live (`.env.production`):

```bash
npm run dry-run:receipt
```

Event-purity live (`.env.event-purity-production` — use this before `./start-event-purity-production.sh`):

```bash
npm run dry-run:receipt:event-purity-production
```

Start the bot within **15 minutes** of generating the receipt (safety gate TTL).

## Ubuntu VM

```bash
chmod +x start-simulation.sh start-production.sh start-production-budget.sh \
  start-event-purity-soak.sh start-event-purity-production.sh \
  watch-bot.sh \
  scripts/launcher-run-bot-detached.sh
./start-event-purity-soak.sh         # 48h shadow soak (recommended)
./start-event-purity-production.sh   # live after soak passes
./watch-bot.sh                       # live monitor (status + session summary)
./watch-bot.sh --once                # single snapshot
./start-simulation.sh                # legacy soak
./start-production.sh                # legacy live
```

### Event-purity profile bootstrap

`npm run env:bootstrap` now also writes `.env.event-purity-soak` and `.env.event-purity-production` from your base `.env` / `.env.production`, with event-purity flags applied. Merge new keys from `.env.example`:

```bash
npm run env:merge-example -- --target .env.event-purity-soak
npm run env:merge-example -- --target .env.event-purity-production
```

Launchers run `scripts/preflight-event-purity-env.mjs` (requires `WS_RPC_URL_PRIMARY`, execution RPC, `FLASHBLOCKS_ENABLED=true`).

Legacy `.env` remains a convenience copy; launchers do **not** load it unless you set `DOTENV_CONFIG_PATH` manually.
