@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  Aave V3 Liquidator - LIVE (ts-node)
echo ========================================
echo.
echo Pre-flight: stop bots and clear stale lock...
call npm run bot:stop
echo.
echo Mode: npm run start:live (ts-node src\index.ts), SIMULATION_MODE=false
echo Safety gate: ON (dry-run receipt required — see .env.example)
echo Launch: detached (no build step — uses src directly)
echo Logs: logs\latest-session.txt
echo Stop: Stop Bot.cmd or npm run bot:stop
echo.

set BOT_LOG_PREFIX=live-tsnode
set BOT_WINDOW_TITLE=Aave Liquidator - Live (ts-node)
set USE_START_LIVE=1
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=

call scripts\launcher-run-bot-detached.cmd
endlocal
