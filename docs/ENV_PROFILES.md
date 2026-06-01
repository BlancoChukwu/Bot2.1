# Environment profiles (VM / desktop)

Three gitignored env files drive one-command launchers. Never commit them.

| File | Launcher (Windows) | Launcher (Ubuntu) | Mode |
| --- | --- | --- | --- |
| `.env.simulation` | `Start Simulation Bot.cmd` | `./start-simulation.sh` | Soak: `SIMULATION_MODE=true`, `RPC_BUDGET_MODE=true` |
| `.env.production` | `Start Production Bot.cmd` | `./start-production.sh` | Live: standard RPC profile |
| `.env.production.budget` | `Start Production Bot (Budget).cmd` | `./start-production-budget.sh` | Live: `RPC_BUDGET_MODE=true` |

## Bootstrap from current `.env`

```bash
npm run env:bootstrap
```

Copies RPC keys, wallet, receiver, FTRL, and dry-run receipt fields into `.env.production`, then derives simulation and budget variants.

## Dry-run receipt

Applies to `.env.production` by default:

```bash
npm run dry-run:receipt
```

## Ubuntu VM

```bash
chmod +x start-simulation.sh start-production.sh start-production-budget.sh scripts/launcher-run-bot-detached.sh
./start-simulation.sh    # soak
./start-production.sh    # live after validation
```

Legacy `.env` remains a convenience copy; launchers do **not** load it unless you set `DOTENV_CONFIG_PATH` manually.
