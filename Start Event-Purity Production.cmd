@echo off
cd /d "%~dp0"

echo ========================================
echo  Aave V3 - EVENT-PURITY PRODUCTION
echo ========================================
echo.
echo Profile: .env.event-purity-production
echo   LIVE liquidation (ENABLE_LIVE_TX=true)
echo   Native Flashblocks WS + tiered confirm
echo   Arbitrage disabled (liq focus)
echo   Deployment safety gate ON
echo.
echo Requires: Setup Dry Run Receipt.cmd within 15 min of launch
echo First time? Run: npm run env:bootstrap
echo        then: npm run env:merge-example -- --target .env.event-purity-production
echo        then: npm run env:sync-receiver-v5
echo WARNING: Live mode needs deployed v5 receiver + successful soak.
echo.
call scripts\launcher-set-dotenv.cmd .env.event-purity-production
if errorlevel 1 (
  echo.
  echo Missing .env.event-purity-production — run npm run env:bootstrap
  pause
  exit /b 1
)

echo Pre-flight: stop bots and clear stale lock...
call npm run bot:stop
echo.
call node scripts\ensure-redis.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
echo.

call scripts\build-dist.cmd
if errorlevel 1 (
  pause
  exit /b 1
)

call scripts\preflight-production-env.cmd
call scripts\preflight-event-purity-env.cmd
if errorlevel 1 (
  pause
  exit /b 1
)

set BOT_LOG_PREFIX=event-purity-production
set BOT_WINDOW_TITLE=Aave Liquidator - Event-Purity Production
set USE_START_LIVE=
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=false

call scripts\launcher-run-bot-detached.cmd
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
