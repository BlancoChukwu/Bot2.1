@echo off
cd /d "%~dp0"

echo ========================================
echo  Aave V3 Liquidator - PRODUCTION (BUDGET)
echo ========================================
echo.
echo Env file: .env.production.budget (RPC_BUDGET_MODE=true)
echo.
call scripts\launcher-set-dotenv.cmd .env.production.budget
if errorlevel 1 (
  pause
  exit /b 1
)

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

call scripts\build-dist.cmd
if errorlevel 1 (
  pause
  exit /b 1
)

call scripts\preflight-production-env.cmd
set BOT_LOG_PREFIX=production-budget
set BOT_WINDOW_TITLE=Aave Liquidator - Production (Budget)
set USE_START_LIVE=
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=false

call scripts\launcher-run-bot-detached.cmd
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
