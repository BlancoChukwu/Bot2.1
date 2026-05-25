@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  Aave V3 Liquidator - PRODUCTION
echo ========================================
echo.
echo Pre-flight: stop bots and clear stale lock...
call npm run bot:stop
echo.
echo Mode: build + node dist\src\index.js, SIMULATION_MODE=false
echo Safety gate: ON (dry-run receipt required — see .env.example)
echo Launch: detached (long-running; survives closing this window)
echo Logs: logs\latest-session.txt
echo Stop: Stop Bot.cmd or npm run bot:stop
echo.

set BOT_LOG_PREFIX=production
set BOT_WINDOW_TITLE=Aave Liquidator - Production
set USE_START_LIVE=
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=

call scripts\launcher-run-bot-detached.cmd
endlocal
