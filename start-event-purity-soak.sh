#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Aave V3 — EVENT-PURITY 48h SOAK (shadow)"
echo "Profile: .env.event-purity-soak"
echo "Branch:  revised-live-bot (pull before start — includes oracle validation + USDbC peg fast-path)"
if [[ ! -f "$ROOT/.env.event-purity-soak" ]]; then
  echo "Missing .env.event-purity-soak — run: npm run env:bootstrap"
  exit 1
fi

export DOTENV_CONFIG_PATH="$ROOT/.env.event-purity-soak"
export BOT_ENV_FILE=".env.event-purity-soak"
export BOT_LOG_PREFIX=event-purity-soak
export BOT_WINDOW_TITLE="Aave Liquidator - Event-Purity Soak"
export USE_START_LIVE=
export SIMULATION_MODE=true
export SKIP_DEPLOYMENT_SAFETY_GATE=true

npm run bot:stop
if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found — install with: npm i -g pm2"
  exit 1
fi
git pull --ff-only origin master
echo "git_head=$(git rev-parse --short HEAD)"
node scripts/ensure-redis.mjs
npm run build
node scripts/preflight-event-purity-env.mjs "$DOTENV_CONFIG_PATH"
exec bash scripts/launcher-run-bot-detached.sh
