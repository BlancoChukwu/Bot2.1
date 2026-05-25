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

(
  echo log=%LOGFILE%
  echo err=%ERRFILE%
  echo started=%LOGSTAMP%
  echo prefix=%BOT_LOG_PREFIX%
  echo detached=true
) > logs\latest-session.txt

if not defined NODE_OPTIONS set NODE_OPTIONS=--max-old-space-size=768 --expose-gc

chcp 65001>nul
if "%USE_START_LIVE%"=="1" (
  set RUN_CMD=call npm run start:live
) else (
  set RUN_CMD=node dist\src\index.js
)

echo.
echo Launching bot in a detached window (survives parent shell exit)...
echo   %LOGFILE%
echo   %ERRFILE%
echo.
echo Tail: Get-Content "%LOGFILE%" -Wait -Tail 20
echo Stop: npm run bot:stop
echo.

set "DETACHED_CMD=cd /d "%CD%" && %RUN_CMD% >> "%LOGFILE%" 2>> "%ERRFILE%""
start "%BOT_WINDOW_TITLE%" /MIN cmd /c "%DETACHED_CMD%"

echo Detached bot started. This launcher window can close safely.
goto :done

:failed
echo.
echo Startup failed. See messages above.
exit /b 1

:done
endlocal
exit /b 0
