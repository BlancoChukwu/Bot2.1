#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Aave V3 Liquidator — SIMULATION (budget mode)"
export DOTENV_CONFIG_PATH="$ROOT/.env.simulation"
export BOT_ENV_FILE=".env.simulation"
export BOT_LOG_PREFIX=simulation
export BOT_WINDOW_TITLE="Aave Liquidator - Simulation"
export USE_START_LIVE=
export SIMULATION_MODE=true
export SKIP_DEPLOYMENT_SAFETY_GATE=false

node scripts/ensure-redis.mjs
npm run build
exec bash scripts/launcher-run-bot-detached.sh
