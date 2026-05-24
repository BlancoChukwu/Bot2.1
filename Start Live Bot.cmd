@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Starting LIVE bot via npm run start:live (ts-node)...
echo WARNING: SIMULATION_MODE=false. Safety gate still applies.
echo Output is written under logs\live-tsnode-*.log
echo.

set BOT_LOG_PREFIX=live-tsnode
set BOT_WINDOW_TITLE=Aave Liquidator - Live (ts-node)
set USE_START_LIVE=1
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=

call scripts\launcher-run-bot.cmd
endlocal
