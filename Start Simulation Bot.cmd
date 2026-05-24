@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  Aave V3 Liquidator - SIMULATION
echo ========================================
echo.
echo Uses: .env in this folder + SIMULATION_MODE=true
echo Output is written under logs\simulation-*.log
echo.

set BOT_LOG_PREFIX=simulation
set BOT_WINDOW_TITLE=Aave Liquidator - Simulation
set USE_START_LIVE=
set SIMULATION_MODE=true
set SKIP_DEPLOYMENT_SAFETY_GATE=

call scripts\launcher-run-bot.cmd
endlocal
