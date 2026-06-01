@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

if "%BOT_LOG_PREFIX%"=="" set BOT_LOG_PREFIX=desktop
if "%BOT_WINDOW_TITLE%"=="" set BOT_WINDOW_TITLE=Aave Liquidator - %BOT_LOG_PREFIX%
title %BOT_WINDOW_TITLE%

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

if "%USE_START_LIVE%"=="1" (
  if not exist "src\index.ts" (
    echo Missing src\index.ts
    goto :failed
  )
) else (
  if not exist "dist\src\index.js" (
    echo Building TypeScript...
    call npm run build
    if errorlevel 1 goto :failed
  )
)

echo Stopping any existing bot instance...
call node scripts\ensure-single-bot.mjs --stop

if not exist "logs" mkdir logs
if not exist ".runtime" mkdir .runtime

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set LOGSTAMP=%%i
set LOGFILE=logs\%BOT_LOG_PREFIX%-%LOGSTAMP%.log
set ERRFILE=logs\%BOT_LOG_PREFIX%-%LOGSTAMP%.err.log

call "%~dp0preflight-production-env.cmd"
call "%~dp0write-launch-session.cmd"
if errorlevel 1 goto :failed

(
  echo log=%LOGFILE%
  echo err=%ERRFILE%
  echo started=%LOGSTAMP%
  echo prefix=%BOT_LOG_PREFIX%
  echo detached=true
  echo child_script=scripts\run-bot-detached-child.cmd
  echo node_options=%NODE_OPTIONS%
  echo rust_hotpath=%RUST_HOTPATH_ENABLED%
  echo simulation_mode=%SIMULATION_MODE%
  echo skip_deployment_gate=%SKIP_DEPLOYMENT_SAFETY_GATE%
  echo env_file=%BOT_ENV_FILE%
  echo dotenv=%DOTENV_CONFIG_PATH%
) > logs\latest-session.txt

chcp 65001>nul

echo.
echo Launching bot in a detached window (survives parent shell exit)...
echo   %LOGFILE%
echo   %ERRFILE%
echo.
echo Tail: Get-Content "%LOGFILE%" -Wait -Tail 20
echo Stop: npm run bot:stop
echo.

set "CHILD_LAUNCHER=%~dp0run-bot-detached-child.cmd"
start "" /MIN cmd /c ""%CHILD_LAUNCHER%""

echo Waiting for bot to start...
call node scripts\verify-bot-launch.mjs "%LOGFILE%"
if errorlevel 1 (
  echo.
  echo Launch verification failed. Open logs\latest-session.txt for paths.
  goto :failed
)

echo.
echo Detached bot started. This launcher window can close safely.
goto :done

:failed
echo.
echo Startup failed. See messages above.
pause
exit /b 1

:done
endlocal
exit /b 0
