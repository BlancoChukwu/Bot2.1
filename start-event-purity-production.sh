#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Aave V3 — EVENT-PURITY PRODUCTION (live)"
echo "Profile: .env.event-purity-production"
echo "WARNING: Requires deployed v5 receiver + dry-run receipt within 15 minutes"
if [[ ! -f "$ROOT/.env.event-purity-production" ]]; then
  echo "Missing .env.event-purity-production — run: npm run env:bootstrap"
  exit 1
fi

export DOTENV_CONFIG_PATH="$ROOT/.env.event-purity-production"
export BOT_ENV_FILE=".env.event-purity-production"
export BOT_LOG_PREFIX=event-purity-production
export BOT_WINDOW_TITLE="Aave Liquidator - Event-Purity Production"
export USE_START_LIVE=
export SIMULATION_MODE=false
export SKIP_DEPLOYMENT_SAFETY_GATE=false

npm run bot:stop
node scripts/ensure-redis.mjs
npm run build
node scripts/preflight-event-purity-env.mjs "$DOTENV_CONFIG_PATH"
exec bash scripts/launcher-run-bot-detached.sh
