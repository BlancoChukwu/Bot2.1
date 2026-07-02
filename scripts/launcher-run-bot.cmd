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
) > logs\latest-session.txt

echo.
echo Logging to:
echo   %LOGFILE%
echo   %ERRFILE%
echo.
echo Tail in another terminal: Get-Content "%LOGFILE%" -Wait -Tail 20
echo Audit when done: node scripts\audit-session.mjs "%LOGFILE%"
echo.

call "%~dp0preflight-production-env.cmd"

chcp 65001>nul
if "%USE_START_LIVE%"=="1" (
  echo Starting: npm run start:live
  call npm run start:live >> "%LOGFILE%" 2>> "%ERRFILE%"
) else (
  echo Starting via PM2: ecosystem.config.cjs
  call node scripts\pm2-bot-launch.mjs --output "%LOGFILE%" --error "%ERRFILE%"
  set EXIT_CODE=0
  echo.
  echo Bot supervised by PM2. Tail: pm2 logs aave-liquidator-base
  echo Session log: %LOGFILE%
  goto :done
)

>> "%LOGFILE%" echo.
>> "%LOGFILE%" echo {"msg":"launcher_session_exit","exitCode":%EXIT_CODE%,"logFile":"%LOGFILE%","errFile":"%ERRFILE%","time":"%LOGSTAMP%"}

echo.
echo Bot process exited with code %EXIT_CODE%.
echo Logs saved under logs\
goto :done

:failed
echo.
echo Startup failed. See messages above.
pause
exit /b 1

:done
pause
endlocal
