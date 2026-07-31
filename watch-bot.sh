#!/usr/bin/env bash
# Live bot monitor — one dense ops screen (status, liquidations, health, alerts).
#
# Usage:
#   ./watch-bot.sh              # refresh every 30s (default)
#   ./watch-bot.sh --once       # single snapshot, exit
#   ./watch-bot.sh --audit      # include full audit-session.mjs report
#   ./watch-bot.sh --interval 10
#   ./watch-bot.sh --log logs/my-session.log
#   ./watch-bot.sh --liquidations              # live stream: evals / sent / fails
#   ./watch-bot.sh --liquidations --all-evals  # include healthy HF skips
#   ./watch-bot.sh --liquidations --backlog 80
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

INTERVAL=30
ONCE=false
AUDIT=false
LIQUIDATIONS=false
ALL_EVALS=false
BACKLOG=40
METRICS_PORT="${METRICS_PORT:-9090}"
LOG_FILE=""

# ANSI (disabled when not a TTY)
if [[ -t 1 && "${NO_COLOR:-}" == "" ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'
  C_BG_GREEN=$'\033[42;30;1m'
  C_BG_RED=$'\033[41;37;1m'
  C_BG_YELLOW=$'\033[43;30;1m'
  C_BLINK=$'\033[5m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_CYAN=""
  C_BG_GREEN=""; C_BG_RED=""; C_BG_YELLOW=""; C_BLINK=""
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) ONCE=true; shift ;;
    --audit) AUDIT=true; shift ;;
    --liquidations) LIQUIDATIONS=true; shift ;;
    --all-evals) ALL_EVALS=true; shift ;;
    --backlog) BACKLOG="${2:?missing backlog value}"; shift 2 ;;
    --interval) INTERVAL="${2:?missing interval value}"; shift 2 ;;
    --log) LOG_FILE="${2:?missing log path}"; shift 2 ;;
    --metrics-port) METRICS_PORT="${2:?missing port}"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

resolve_log_file() {
  if [[ -n "$LOG_FILE" ]]; then
    echo "$LOG_FILE"
    return
  fi
  local resolved
  resolved="$(node scripts/resolve-active-session-log.mjs 2>/dev/null || true)"
  if [[ -n "$resolved" && -f "$resolved" ]]; then
    echo "$resolved"
    return
  fi
  if [[ -f logs/latest-session.txt ]]; then
    local from_meta
    from_meta="$(grep -E '^log=' logs/latest-session.txt | head -1 | cut -d= -f2- || true)"
    if [[ -n "$from_meta" && -f "$from_meta" ]]; then
      echo "$from_meta"
      return
    fi
  fi
  local latest
  latest="$(ls -t logs/event-purity-*.log logs/*.log 2>/dev/null | head -1 || true)"
  echo "${latest:-}"
}

infer_mode() {
  local prefix="" env_file="" log_path
  log_path="$(resolve_log_file)"
  if [[ -f logs/latest-session.txt ]]; then
    prefix="$(grep -E '^prefix=' logs/latest-session.txt | head -1 | cut -d= -f2- || true)"
    env_file="$(grep -E '^env_file=' logs/latest-session.txt | head -1 | cut -d= -f2- || true)"
  fi
  local blob
  blob="$(printf '%s %s %s' "$prefix" "$env_file" "$log_path" | tr '[:upper:]' '[:lower:]')"
  if [[ "$blob" == *soak* || "$blob" == *simulation* ]]; then
    echo "soak"
  elif [[ "$blob" == *production* || "$blob" == *live* ]]; then
    echo "live"
  else
    echo "unknown"
  fi
}

bot_running() {
  if [[ -f .runtime/bot.lock ]]; then
    local lock_pid
    lock_pid="$(head -1 .runtime/bot.lock | tr -d '[:space:]')"
    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

critical_count() {
  local log_path count
  log_path="$(resolve_log_file)"
  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    echo "0"
    return
  fi
  count="$(node scripts/detect-critical-log-errors.mjs "$log_path" 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { console.log(JSON.parse(d).count||0); } catch { console.log(0); }
    });
  " || echo 0)"
  echo "${count:-0}"
}

print_status_banner() {
  local running=false mode crit ts
  mode="$(infer_mode)"
  ts="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  crit="$(critical_count)"
  if bot_running; then running=true; fi

  echo "══════════════════════════════════════════════════════════════"
  echo "  ${C_BOLD}Aave Liquidator — watch-bot${C_RESET}  ${C_DIM}${ts}${C_RESET}"
  echo "══════════════════════════════════════════════════════════════"
  echo ""

  if [[ "$running" == true ]]; then
    printf "  %s RUNNING %s" "${C_BG_GREEN}" "${C_RESET}"
  else
    printf "  %s  OFF   %s" "${C_BG_RED}" "${C_RESET}"
  fi

  case "$mode" in
    soak) printf "  %smode=soak (shadow / no live TX)%s" "${C_CYAN}" "${C_RESET}" ;;
    live) printf "  %smode=LIVE%s" "${C_YELLOW}${C_BOLD}" "${C_RESET}" ;;
    *)    printf "  %smode=unknown%s" "${C_DIM}" "${C_RESET}" ;;
  esac

  if [[ "$crit" != "0" ]]; then
    printf "  %s%s⚠ ALERT x%s%s" "${C_BLINK}" "${C_BG_YELLOW}" "$crit" "${C_RESET}"
  fi
  echo ""
}

print_session_meta() {
  echo ""
  echo "── Session ──"
  if [[ -f logs/latest-session.txt ]]; then
    while IFS= read -r line; do
      echo "  $line"
    done < logs/latest-session.txt
  else
    echo "  (no logs/latest-session.txt — pass --log or start via launcher)"
  fi
  echo "  active_log=$(resolve_log_file)"
}

print_process_status() {
  echo ""
  echo "── Process ──"
  if node scripts/ensure-single-bot.mjs --status 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const s=JSON.parse(d);
        console.log('  lockPid:', s.lockPid ?? 'none');
        console.log('  lockHolderAlive:', s.lockHolderAlive);
        console.log('  botProcesses:', s.count);
        for (const p of (s.botProcesses||[])) {
          console.log('  pid', p.pid);
        }
        if (!s.singleInstance && s.count > 1) process.exitCode=2;
      } catch { console.log('  (could not parse bot status)'); }
    });
  "; then
    :
  else
    echo "  ${C_YELLOW}WARNING: multiple bot processes detected${C_RESET}" >&2
  fi
  if [[ -f .runtime/bot.lock ]]; then
    local lock_pid rss
    lock_pid="$(head -1 .runtime/bot.lock | tr -d '[:space:]')"
    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
      rss="$(ps -p "$lock_pid" -o rss= 2>/dev/null | tr -d ' ' || true)"
      if [[ -n "$rss" ]]; then
        echo "  lockRssKb: $rss (~$(( rss / 1024 )) MB)"
      fi
      echo "  elapsed: $(ps -p "$lock_pid" -o etime= 2>/dev/null | tr -d ' ' || echo '?')"
    fi
  fi
}

print_http_status() {
  echo ""
  echo "── HTTP (port $METRICS_PORT) ──"
  local health status
  health="$(curl -sf --max-time 3 "http://127.0.0.1:${METRICS_PORT}/healthz" 2>/dev/null || echo "")"
  status="$(curl -sf --max-time 3 "http://127.0.0.1:${METRICS_PORT}/status" 2>/dev/null || echo "")"
  if [[ -z "$health" ]]; then
    echo "  /healthz: ${C_RED}unreachable${C_RESET}"
  else
    echo "  /healthz: $health"
  fi
  if [[ -z "$status" ]]; then
    echo "  /status:  ${C_RED}unreachable${C_RESET}"
  else
    echo "  /status:  $status"
  fi
}

print_session_summary() {
  echo ""
  local log_path mode
  log_path="$(resolve_log_file)"
  mode="$(infer_mode)"
  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    echo "── Liquidations ──"
    echo "  (no log file found)"
    echo ""
    echo "── Health ──"
    echo "  (no log file found)"
    return
  fi
  node scripts/watch-bot-summary.mjs "$log_path" --mode "$mode" || true
}

print_critical_scan() {
  echo ""
  local log_path
  log_path="$(resolve_log_file)"
  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    return
  fi
  echo "── Critical alerts ──"
  if node scripts/detect-critical-log-errors.mjs "$log_path" 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const r=JSON.parse(d);
        if (r.count === 0) { console.log('  none'); return; }
        console.log('  count:', r.count);
        for (const e of (r.critical||[]).slice(-5)) {
          console.log('  ', e.time, e.msg);
        }
      } catch { console.log('  (scan failed)'); }
    });
  "; then
    :
  else
    echo "  ${C_RED}${C_BOLD}CRITICAL events found — see above${C_RESET}" >&2
  fi
}

print_recent_logs() {
  echo ""
  local log_path
  log_path="$(resolve_log_file)"
  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    echo "── Recent logs ──"
    echo "  (no log file)"
    return
  fi
  echo "── Recent logs (last 6 lines) ──"
  tail -n 6 "$log_path" | while IFS= read -r line; do
    if [[ ${#line} -gt 200 ]]; then
      echo "  ${line:0:200}..."
    else
      echo "  $line"
    fi
  done
  echo ""
  echo "  ${C_DIM}Full tail: tail -f $log_path${C_RESET}"
}

print_audit() {
  if [[ "$AUDIT" != true ]]; then
    return
  fi
  local log_path
  log_path="$(resolve_log_file)"
  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    return
  fi
  echo ""
  echo "── Full audit (audit-session.mjs) ──"
  node scripts/audit-session.mjs "$log_path" 2>/dev/null || echo "  audit failed"
}

render_once() {
  print_status_banner
  print_session_summary
  print_critical_scan
  print_process_status
  print_http_status
  print_session_meta
  print_recent_logs
  print_audit
  echo ""
}

if [[ "$LIQUIDATIONS" == true ]]; then
  log_path="$(resolve_log_file)"
  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    echo "No log file found. Pass --log path/to.log or start the bot via launcher." >&2
    exit 1
  fi
  liq_args=("$log_path" "--backlog" "$BACKLOG")
  if [[ "$ALL_EVALS" == true ]]; then
    liq_args+=(--all-evals)
  fi
  if [[ "$ONCE" == true ]]; then
    liq_args+=(--once)
  fi
  exec node scripts/watch-bot-liquidations.mjs "${liq_args[@]}"
fi

if [[ "$ONCE" == true ]]; then
  render_once
  exit 0
fi

while true; do
  clear 2>/dev/null || true
  render_once
  echo "Refreshing in ${INTERVAL}s — Ctrl+C to exit (use --once for a single snapshot)"
  sleep "$INTERVAL"
done
