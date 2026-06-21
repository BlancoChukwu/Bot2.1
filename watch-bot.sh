#!/usr/bin/env bash
# Live bot monitor: process status, HTTP /status, session summary, recent logs.
#
# Usage:
#   ./watch-bot.sh              # refresh every 30s (default)
#   ./watch-bot.sh --once       # single snapshot, exit
#   ./watch-bot.sh --audit      # include full audit-session.mjs report
#   ./watch-bot.sh --interval 10
#   ./watch-bot.sh --log logs/my-session.log
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

INTERVAL=30
ONCE=false
AUDIT=false
METRICS_PORT="${METRICS_PORT:-9090}"
LOG_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) ONCE=true; shift ;;
    --audit) AUDIT=true; shift ;;
    --interval) INTERVAL="${2:?missing interval value}"; shift 2 ;;
    --log) LOG_FILE="${2:?missing log path}"; shift 2 ;;
    --metrics-port) METRICS_PORT="${2:?missing port}"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"
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

print_header() {
  echo "══════════════════════════════════════════════════════════════"
  echo "  Aave Liquidator — watch-bot  $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  echo "══════════════════════════════════════════════════════════════"
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
  local log_path
  log_path="$(resolve_log_file)"
  if [[ -n "$log_path" ]]; then
    echo "  active_log=$log_path"
  fi
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
    echo "  WARNING: multiple bot processes detected" >&2
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
    echo "  /healthz: unreachable"
  else
    echo "  /healthz: $health"
  fi
  if [[ -z "$status" ]]; then
    echo "  /status:  unreachable"
  else
    echo "  /status:  $status"
  fi
}

print_session_summary() {
  echo ""
  local log_path
  log_path="$(resolve_log_file)"
  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    echo "── Session summary ──"
    echo "  (no log file found)"
    return
  fi
  node scripts/watch-bot-summary.mjs "$log_path" || true
}

print_critical_scan() {
  echo ""
  local log_path
  log_path="$(resolve_log_file)"
  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    return
  fi
  echo "── Critical scan ──"
  if node scripts/detect-critical-log-errors.mjs "$log_path" 2>/dev/null | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const r=JSON.parse(d);
        if (r.count === 0) { console.log('  none'); return; }
        console.log('  count:', r.count);
        for (const e of (r.critical||[]).slice(-3)) {
          console.log('  ', e.time, e.msg);
        }
      } catch { console.log('  (scan failed)'); }
    });
  "; then
    :
  else
    echo "  CRITICAL events found — see above" >&2
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
  echo "── Recent logs (last 8 lines) ──"
  tail -n 8 "$log_path" | while IFS= read -r line; do
    if [[ ${#line} -gt 200 ]]; then
      echo "  ${line:0:200}..."
    else
      echo "  $line"
    fi
  done
  echo ""
  echo "  Full tail: tail -f $log_path"
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
  print_header
  print_session_meta
  print_process_status
  print_http_status
  print_session_summary
  print_critical_scan
  print_recent_logs
  print_audit
  echo ""
}

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
