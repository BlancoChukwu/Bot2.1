@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  Aave V3 Liquidator - PRODUCTION / LIVE
echo ========================================
echo.
echo Uses: .env in this folder + SIMULATION_MODE=false
echo Live safety gate still applies (dry-run receipt, margin, chains).
echo Output is written under logs\production-*.log
echo.

set BOT_LOG_PREFIX=production
set BOT_WINDOW_TITLE=Aave Liquidator - Production (Live)
set USE_START_LIVE=
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=

call scripts\launcher-run-bot.cmd
endlocal
