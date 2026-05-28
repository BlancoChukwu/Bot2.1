@echo off
cd /d "%~dp0"

echo ========================================
echo  Aave V3 Liquidator - SIMULATION SOAK
echo ========================================
echo.
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
set BOT_LOG_PREFIX=simulation
set BOT_WINDOW_TITLE=Aave Liquidator - Simulation
set USE_START_LIVE=
set SIMULATION_MODE=true
set SKIP_DEPLOYMENT_SAFETY_GATE=false

call scripts\launcher-run-bot-detached.cmd
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
