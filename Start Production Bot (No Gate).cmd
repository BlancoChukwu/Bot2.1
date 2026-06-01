@echo off
cd /d "%~dp0"

echo ========================================
echo  PRODUCTION - SAFETY GATE DISABLED
echo ========================================
echo.
echo Env file: .env.production
echo WARNING: SKIP_DEPLOYMENT_SAFETY_GATE=true
echo.
pause

call scripts\launcher-set-dotenv.cmd .env.production
if errorlevel 1 exit /b 1

echo Pre-flight: stop bots and clear stale lock...
call npm run bot:stop
echo.

call scripts\build-dist.cmd
if errorlevel 1 exit /b 1

call scripts\preflight-production-env.cmd

set BOT_LOG_PREFIX=production-no-gate
set BOT_WINDOW_TITLE=Aave Liquidator - Production (No Gate)
set USE_START_LIVE=
set SIMULATION_MODE=false
set SKIP_DEPLOYMENT_SAFETY_GATE=true

call scripts\launcher-run-bot-detached.cmd
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
