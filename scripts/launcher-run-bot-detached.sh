#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BOT_LOG_PREFIX="${BOT_LOG_PREFIX:-desktop}"
BOT_WINDOW_TITLE="${BOT_WINDOW_TITLE:-Aave Liquidator - ${BOT_LOG_PREFIX}}"

if [[ -z "${DOTENV_CONFIG_PATH:-}" ]]; then
  echo "DOTENV_CONFIG_PATH is required. Use start-simulation.sh or start-production.sh."
  exit 1
fi
if [[ ! -f "$DOTENV_CONFIG_PATH" ]]; then
  echo "env_file_missing: $DOTENV_CONFIG_PATH"
  echo "Run: node scripts/bootstrap-env-profiles.mjs"
  exit 1
fi

export DOTENV_CONFIG_PATH
export BOT_ENV_FILE="${BOT_ENV_FILE:-$(basename "$DOTENV_CONFIG_PATH")}"

if [[ ! -d node_modules ]]; then
  npm install
fi

if [[ "${USE_START_LIVE:-}" == "1" ]]; then
  [[ -f src/index.ts ]] || { echo "Missing src/index.ts"; exit 1; }
else
  if [[ ! -f dist/src/index.js ]]; then
    npm run build
  fi
fi

npm run bot:stop

mkdir -p logs .runtime
LOGSTAMP="$(date +%Y%m%d-%H%M%S)"
export LOGFILE="logs/${BOT_LOG_PREFIX}-${LOGSTAMP}.log"
export ERRFILE="logs/${BOT_LOG_PREFIX}-${LOGSTAMP}.err.log"

export SIMULATION_MODE="${SIMULATION_MODE:-true}"
export SKIP_DEPLOYMENT_SAFETY_GATE="${SKIP_DEPLOYMENT_SAFETY_GATE:-false}"
export SKIP_COLD_START_FULL_SWEEP="${SKIP_COLD_START_FULL_SWEEP:-true}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=650 --expose-gc}"
export ENABLE_HEAP_SNAPSHOTS="${ENABLE_HEAP_SNAPSHOTS:-false}"
export RUST_HOTPATH_ENABLED="${RUST_HOTPATH_ENABLED:-false}"

SESSION_FILE="$ROOT/.runtime/launch-session.sh"
cat > "$SESSION_FILE" <<EOF
#!/usr/bin/env bash
export BOT_REPO_ROOT="$ROOT"
export DOTENV_CONFIG_PATH="$DOTENV_CONFIG_PATH"
export BOT_ENV_FILE="$BOT_ENV_FILE"
export NODE_OPTIONS="$NODE_OPTIONS"
export RUST_HOTPATH_ENABLED="$RUST_HOTPATH_ENABLED"
export SIMULATION_MODE="$SIMULATION_MODE"
export SKIP_DEPLOYMENT_SAFETY_GATE="$SKIP_DEPLOYMENT_SAFETY_GATE"
export SKIP_COLD_START_FULL_SWEEP="$SKIP_COLD_START_FULL_SWEEP"
export USE_START_LIVE="${USE_START_LIVE:-}"
export BOT_LOGFILE="$ROOT/$LOGFILE"
export BOT_ERRFILE="$ROOT/$ERRFILE"
cd "\$BOT_REPO_ROOT"
export PATH="\$PATH:/usr/local/bin:\$HOME/.local/bin:\$HOME/.npm-global/bin"
if [[ "\$USE_START_LIVE" == "1" ]]; then
  npm run start:live >> "\$BOT_LOGFILE" 2>> "\$BOT_ERRFILE"
else
  node scripts/pm2-bot-launch.mjs --output "\$BOT_LOGFILE" --error "\$BOT_ERRFILE"
fi
echo >> "\$BOT_LOGFILE"
echo "{\"msg\":\"launcher_session_exit\",\"exitCode\":\$?}" >> "\$BOT_LOGFILE"
EOF
chmod +x "$SESSION_FILE"

{
  echo "log=$LOGFILE"
  echo "err=$ERRFILE"
  echo "started=$LOGSTAMP"
  echo "prefix=$BOT_LOG_PREFIX"
  echo "env_file=$BOT_ENV_FILE"
  echo "dotenv=$DOTENV_CONFIG_PATH"
  echo "detached=true"
  echo "pm2_managed=true"
  echo "git_head=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "simulation_mode=$SIMULATION_MODE"
} > logs/latest-session.txt

nohup bash "$SESSION_FILE" >/dev/null 2>&1 &
echo "Detached bot started."
echo "  $LOGFILE"
echo "  Tail: tail -f $LOGFILE"
node scripts/verify-bot-launch.mjs "$LOGFILE"
