@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  PRODUCTION / LIVE - SAFETY GATE OFF
echo ========================================
echo.
echo SKIP_DEPLOYMENT_SAFETY_GATE=true
echo Dry-run receipt checks are NOT enforced.
echo Real transactions may be sent if SIMULATION_MODE=false.
echo Output is written under logs\production-no-gate-*.log
echo.
pause

set BOT_LOG_PREFIX=production-no-gate
set BOT_WINDOW_TITLE=Aave Liquidator - Production (No Gate)
set USE_START_LIVE=
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=true

call scripts\launcher-run-bot.cmd
endlocal
