#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Aave V3 Liquidator — PRODUCTION (RPC budget mode)"
export DOTENV_CONFIG_PATH="$ROOT/.env.production.budget"
export BOT_ENV_FILE=".env.production.budget"
export BOT_LOG_PREFIX=production-budget
export BOT_WINDOW_TITLE="Aave Liquidator - Production (Budget)"
export USE_START_LIVE=
export SIMULATION_MODE=false
export SKIP_DEPLOYMENT_SAFETY_GATE=false

npm run bot:stop
node scripts/ensure-redis.mjs
npm run build
exec bash scripts/launcher-run-bot-detached.sh
