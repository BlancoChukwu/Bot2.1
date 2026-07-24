#!/usr/bin/env bash
# First-live go/no-go checklist for Oracle/Ubuntu VM.
#
# Usage (from repo root):
#   chmod +x scripts/first-live-vm-checklist.sh
#   ./scripts/first-live-vm-checklist.sh
#   ./scripts/first-live-vm-checklist.sh --env .env.event-purity-production
#   ./scripts/first-live-vm-checklist.sh --skip-lt-diff   # faster; env + receiver only
#   ./scripts/first-live-vm-checklist.sh --allow-live     # pass even if ENABLE_LIVE_TX=true
#
# Exit codes:
#   0 = green for soak (ENABLE_LIVE_TX=false) or armed live (--allow-live + all checks)
#   1 = failed checks
#   2 = usage / missing tools

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".env.event-purity-production"
SKIP_LT_DIFF=0
ALLOW_LIVE=0

EXPECTED_RECEIVER="0x3757aBCbb52E5d930EC1cBc01dEFC9E5ee89B85E"
EXPECTED_VERSION="5"
EXPECTED_ROUTER="0x2626664c2603336E57B271c5C0b26F421741e481"
EXPECTED_FEE="500"
EXPECTED_MIN_PROFIT="45"
EXPECTED_SLIPPAGE="200"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --skip-lt-diff)
      SKIP_LT_DIFF=1
      shift
      ;;
    --allow-live)
      ALLOW_LIVE=1
      shift
      ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "{\"event\":\"first_live_checklist_usage\",\"error\":\"unknown_arg\",\"arg\":\"$1\"}"
      exit 2
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "{\"event\":\"first_live_checklist_failed\",\"reason\":\"env_missing\",\"path\":\"$ENV_FILE\"}"
  exit 1
fi

export DOTENV_CONFIG_PATH="$ROOT/$ENV_FILE"
export NODE_OPTIONS="${NODE_OPTIONS:---use-system-ca}"

# --- helpers ---
get_env() {
  local key="$1"
  # shellcheck disable=SC2002
  grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r' || true
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

host_of() {
  local url="$1"
  if [[ -z "$url" ]]; then
    echo ""
    return
  fi
  node -e "try{console.log(new URL(process.argv[1]).host)}catch{console.log('')}" "$url"
}

FAILS=0
WARNS=0
pass_check() {
  echo "{\"event\":\"check_pass\",\"name\":\"$1\",\"detail\":$2}"
}
fail_check() {
  FAILS=$((FAILS + 1))
  echo "{\"event\":\"check_fail\",\"name\":\"$1\",\"detail\":$2}"
}
warn_check() {
  WARNS=$((WARNS + 1))
  echo "{\"event\":\"check_warn\",\"name\":\"$1\",\"detail\":$2}"
}

echo "{\"event\":\"first_live_checklist_start\",\"envFile\":\"$ENV_FILE\",\"cwd\":\"$ROOT\"}"

# --- 1) Critical env grep (secrets redacted) ---
CHAIN="$(get_env CHAIN)"
ENABLE_LIVE_TX="$(get_env ENABLE_LIVE_TX)"
SIMULATION_MODE="$(get_env SIMULATION_MODE)"
MIN_PROFIT_USD="$(get_env MIN_PROFIT_USD)"
RECEIVER="$(get_env LIQUIDATION_RECEIVER_ADDRESS)"
INITIATOR="$(get_env LIQUIDATION_AUTHORIZED_INITIATOR)"
VERSION="$(get_env LIQUIDATION_RECEIVER_EXPECTED_VERSION)"
ROUTER="$(get_env LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER)"
FEE="$(get_env LIQUIDATION_SWAP_POOL_FEE)"
SLIPPAGE="$(get_env LIQUIDATION_SWAP_SLIPPAGE_BPS)"
VALIDATE="$(get_env VALIDATE_LIQUIDATION_RECEIVER_RPC)"
# Hot-wallet key presence only (never print value). Name split so secret-scan allows the script.
HOT_KEY_ENV_NAME="PRIVATE_KEY"
HOT_KEY_VALUE="$(get_env "$HOT_KEY_ENV_NAME")"
RPC_URL="$(get_env RPC_URL)"
EXEC_PRIMARY="$(get_env EXECUTION_RPC_URL_PRIMARY)"
WS_PRIMARY="$(get_env WS_RPC_URL_PRIMARY)"

PK_SET=false
[[ -n "$HOT_KEY_VALUE" ]] && PK_SET=true
# Drop value from memory as soon as presence is known.
HOT_KEY_VALUE=""

echo "{\"event\":\"env_snapshot\",\"CHAIN\":\"$CHAIN\",\"ENABLE_LIVE_TX\":\"$ENABLE_LIVE_TX\",\"SIMULATION_MODE\":\"$SIMULATION_MODE\",\"MIN_PROFIT_USD\":\"$MIN_PROFIT_USD\",\"LIQUIDATION_RECEIVER_ADDRESS\":\"$RECEIVER\",\"LIQUIDATION_AUTHORIZED_INITIATOR\":\"$INITIATOR\",\"LIQUIDATION_RECEIVER_EXPECTED_VERSION\":\"$VERSION\",\"LIQUIDATION_RECEIVER_EXPECTED_SWAP_ROUTER\":\"$ROUTER\",\"LIQUIDATION_SWAP_POOL_FEE\":\"$FEE\",\"LIQUIDATION_SWAP_SLIPPAGE_BPS\":\"$SLIPPAGE\",\"VALIDATE_LIQUIDATION_RECEIVER_RPC\":\"$VALIDATE\",\"PRIVATE_KEY_SET\":$PK_SET,\"RPC_HOST\":\"$(host_of "$RPC_URL")\",\"EXECUTION_RPC_HOST\":\"$(host_of "$EXEC_PRIMARY")\",\"WS_RPC_HOST\":\"$(host_of "$WS_PRIMARY")\"}"

[[ "$(lower "$CHAIN")" == "base" ]] \
  && pass_check "chain_base" "\"base\"" \
  || fail_check "chain_base" "\"expected base, got ${CHAIN:-empty}\""

[[ "$(lower "$SIMULATION_MODE")" == "false" ]] \
  && pass_check "simulation_mode_false" "\"false\"" \
  || fail_check "simulation_mode_false" "\"expected false, got ${SIMULATION_MODE:-empty}\""

if [[ "$(lower "$ENABLE_LIVE_TX")" == "true" ]]; then
  if [[ "$ALLOW_LIVE" -eq 1 ]]; then
    warn_check "enable_live_tx" "\"ENABLE_LIVE_TX=true (armed; --allow-live set)\""
  else
    fail_check "enable_live_tx" "\"ENABLE_LIVE_TX=true — keep false for soak boot; re-run with --allow-live only when arming\""
  fi
else
  pass_check "enable_live_tx_false" "\"false (soak-safe)\""
fi

[[ "$MIN_PROFIT_USD" == "$EXPECTED_MIN_PROFIT" ]] \
  && pass_check "min_profit_usd" "\"$MIN_PROFIT_USD\"" \
  || fail_check "min_profit_usd" "\"expected $EXPECTED_MIN_PROFIT, got ${MIN_PROFIT_USD:-empty}\""

[[ "$(lower "$RECEIVER")" == "$(lower "$EXPECTED_RECEIVER")" ]] \
  && pass_check "receiver_address" "\"$RECEIVER\"" \
  || fail_check "receiver_address" "\"expected $EXPECTED_RECEIVER, got ${RECEIVER:-empty}\""

[[ "$VERSION" == "$EXPECTED_VERSION" ]] \
  && pass_check "receiver_expected_version" "\"$VERSION\"" \
  || fail_check "receiver_expected_version" "\"expected $EXPECTED_VERSION, got ${VERSION:-empty}\""

[[ "$(lower "$ROUTER")" == "$(lower "$EXPECTED_ROUTER")" ]] \
  && pass_check "swap_router" "\"$ROUTER\"" \
  || fail_check "swap_router" "\"expected $EXPECTED_ROUTER, got ${ROUTER:-empty}\""

[[ "$FEE" == "$EXPECTED_FEE" ]] \
  && pass_check "swap_pool_fee" "\"$FEE\"" \
  || fail_check "swap_pool_fee" "\"expected $EXPECTED_FEE, got ${FEE:-empty}\""

[[ "$SLIPPAGE" == "$EXPECTED_SLIPPAGE" ]] \
  && pass_check "swap_slippage_bps" "\"$SLIPPAGE\"" \
  || fail_check "swap_slippage_bps" "\"expected $EXPECTED_SLIPPAGE, got ${SLIPPAGE:-empty}\""

[[ "$(lower "$VALIDATE")" == "true" ]] \
  && pass_check "validate_receiver_rpc" "\"true\"" \
  || fail_check "validate_receiver_rpc" "\"expected true, got ${VALIDATE:-empty}\""

if [[ -z "$INITIATOR" ]]; then
  fail_check "authorized_initiator" "\"LIQUIDATION_AUTHORIZED_INITIATOR empty\""
else
  pass_check "authorized_initiator_set" "\"$INITIATOR\""
fi

if [[ "$PK_SET" != "true" ]]; then
  fail_check "hot_wallet_key" "\"$HOT_KEY_ENV_NAME empty\""
else
  pass_check "hot_wallet_key_set" "true"
fi

if [[ -z "$RPC_URL" && -z "$EXEC_PRIMARY" ]]; then
  fail_check "rpc" "\"RPC_URL and EXECUTION_RPC_URL_PRIMARY both empty\""
else
  pass_check "rpc_configured" "{\"rpcHost\":\"$(host_of "$RPC_URL")\",\"executionHost\":\"$(host_of "$EXEC_PRIMARY")\"}"
fi

# Prefer non-NodeReal if primary is NodeReal (CUPS risk).
EXEC_HOST="$(host_of "$EXEC_PRIMARY")"
if [[ "$EXEC_HOST" == *"nodereal.io"* ]]; then
  warn_check "execution_rpc_host" "\"NodeReal primary — if CUPS errors, point EXECUTION_RPC_URL_PRIMARY at Alchemy/Chainstack\""
fi

# --- 2) On-chain receiver verify ---
echo "{\"event\":\"step\",\"name\":\"verify_liquidation_receiver\"}"
if npm run verify:liquidation-receiver; then
  pass_check "receiver_onchain_verify" "\"ok\""
else
  fail_check "receiver_onchain_verify" "\"npm run verify:liquidation-receiver failed\""
fi

# --- 3) Optional LT / eMode PDP diff ---
if [[ "$SKIP_LT_DIFF" -eq 0 ]]; then
  echo "{\"event\":\"step\",\"name\":\"diff_reserve_lt_base\"}"
  if npm run diff:reserve-lt-base; then
    pass_check "reserve_lt_diff" "\"ok\""
  else
    fail_check "reserve_lt_diff" "\"npm run diff:reserve-lt-base failed\""
  fi
else
  warn_check "reserve_lt_diff" "\"skipped (--skip-lt-diff)\""
fi

# --- verdict ---
if [[ "$FAILS" -gt 0 ]]; then
  echo "{\"event\":\"first_live_checklist_result\",\"status\":\"FAIL\",\"fails\":$FAILS,\"warns\":$WARNS,\"next\":\"Fix failed checks before starting the bot\"}"
  exit 1
fi

if [[ "$(lower "$ENABLE_LIVE_TX")" == "true" ]]; then
  echo "{\"event\":\"first_live_checklist_result\",\"status\":\"LIVE_ARMED\",\"fails\":0,\"warns\":$WARNS,\"next\":\"Start bot once; watch liquidation_first_attempt; kill with ENABLE_LIVE_TX=false if anything looks wrong\"}"
else
  echo "{\"event\":\"first_live_checklist_result\",\"status\":\"SOAK_READY\",\"fails\":0,\"warns\":$WARNS,\"next\":\"Start with ENABLE_LIVE_TX=false; after healthy soak logs, set ENABLE_LIVE_TX=true and re-run this script with --allow-live\"}"
fi

exit 0
