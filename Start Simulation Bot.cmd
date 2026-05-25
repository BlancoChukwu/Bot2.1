@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  Aave V3 Liquidator - SIMULATION SOAK
echo ========================================
echo.
echo Pre-flight: stop bots and clear stale lock...
call npm run bot:stop
echo.
echo Mode: SIMULATION_MODE=true, USE_EVENT_WATCHLIST from .env
echo Launch: detached (2h+ soak — survives closing this window)
echo Logs: logs\latest-session.txt
echo Stop: Stop Bot.cmd or npm run bot:stop
echo Redis: start .runtime\redis\redis-server.exe if REDIS_URL is set
echo.

set BOT_LOG_PREFIX=simulation
set BOT_WINDOW_TITLE=Aave Liquidator - Simulation
set USE_START_LIVE=
set SIMULATION_MODE=true
set SKIP_DEPLOYMENT_SAFETY_GATE=

call scripts\launcher-run-bot-detached.cmd
endlocal
