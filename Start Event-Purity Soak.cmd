@echo off
cd /d "%~dp0"

echo ========================================
echo  Aave V3 - EVENT-PURITY 48h SOAK
echo ========================================
echo.
echo Profile: .env.event-purity-soak
echo   Shadow only (ENABLE_LIVE_TX=false)
echo   Native Flashblocks WS + local HF model
echo   Bootstrap cache + subgraph fallback
echo   Safety gate skipped (shadow soak)
echo.
echo First time? Run: npm run env:bootstrap
echo        then: npm run env:merge-example -- --target .env.event-purity-soak
echo.
call scripts\launcher-set-dotenv.cmd .env.event-purity-soak
if errorlevel 1 (
  echo.
  echo Missing .env.event-purity-soak — run npm run env:bootstrap
  pause
  exit /b 1
)

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

set BOT_LOG_PREFIX=event-purity-soak
set BOT_WINDOW_TITLE=Aave Liquidator - Event-Purity Soak
set USE_START_LIVE=
set SIMULATION_MODE=true
set SKIP_DEPLOYMENT_SAFETY_GATE=true

call scripts\launcher-run-bot-detached.cmd
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
