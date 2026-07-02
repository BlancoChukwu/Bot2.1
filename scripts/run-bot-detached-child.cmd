@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
set "SESSION_FILE=%REPO_ROOT%\.runtime\launch-session.cmd"

if not exist "%SESSION_FILE%" (
  echo launch_session_missing> "%REPO_ROOT%\logs\launch-child-error.log"
  exit /b 1
)

call "%SESSION_FILE%"
cd /d "%BOT_REPO_ROOT%"

if "%USE_START_LIVE%"=="1" (
  call npm run start:live >> "%BOT_LOGFILE%" 2>> "%BOT_ERRFILE%"
) else (
  if not exist "dist\src\index.js" (
    echo dist_missing_run_npm_build>> "%BOT_LOGFILE%"
    exit /b 1
  )
  call node scripts\pm2-bot-launch.mjs --output "%BOT_LOGFILE%" --error "%BOT_ERRFILE%"
)

set EXIT_CODE=%ERRORLEVEL%
>> "%BOT_LOGFILE%" echo.
>> "%BOT_LOGFILE%" echo {"msg":"launcher_session_exit","exitCode":%EXIT_CODE%,"logFile":"%BOT_LOGFILE%","errFile":"%BOT_ERRFILE%"}
endlocal & exit /b %EXIT_CODE%
