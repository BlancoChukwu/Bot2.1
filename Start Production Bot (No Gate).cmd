@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  PRODUCTION - SAFETY GATE DISABLED
echo ========================================
echo.
echo WARNING: SKIP_DEPLOYMENT_SAFETY_GATE=true
echo Dry-run receipt checks are NOT enforced.
echo Real transactions may be sent when SIMULATION_MODE=false.
echo.
pause

echo Pre-flight: stop bots and clear stale lock...
call npm run bot:stop
echo.

set BOT_LOG_PREFIX=production-no-gate
set BOT_WINDOW_TITLE=Aave Liquidator - Production (No Gate)
set USE_START_LIVE=
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=true

call scripts\launcher-run-bot-detached.cmd
endlocal
