@echo off
cd /d "%~dp0"

echo ========================================
echo  Aave V3 Liquidator - PRODUCTION
echo ========================================
echo.
echo Pre-flight: stop bots and clear stale lock...
call npm run bot:stop
echo.
echo Ensuring Redis (when REDIS_URL is local)...
call node scripts\ensure-redis.mjs
if errorlevel 1 (
  echo Redis is required for gap-replay cursor — fix REDIS_URL or start Redis manually.
  pause
  exit /b 1
)
echo.
echo Build: npm run build
echo Mode: LIVE (SIMULATION_MODE=false)
echo Memory: NODE_OPTIONS=650MB heap
echo Safety: RUST_HOTPATH_ENABLED=false, deployment gate ON
echo If gate blocks: run "Setup Dry Run Receipt.cmd" then relaunch within 15 min
echo Flashblocks: FLASHBLOCKS_ENABLED + FLASHBLOCKS_RPC_URL from .env
echo Logs: logs\latest-session.txt
echo.

call scripts\build-dist.cmd
if errorlevel 1 (
  pause
  exit /b 1
)

call scripts\preflight-production-env.cmd
set BOT_LOG_PREFIX=production
set BOT_WINDOW_TITLE=Aave Liquidator - Production
set USE_START_LIVE=
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=false

call scripts\launcher-run-bot-detached.cmd
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
