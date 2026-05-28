@echo off
rem Writes .runtime\launch-session.cmd with absolute paths and production env for the detached child.
setlocal EnableExtensions
set "REPO_ROOT=%~dp0.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
set "SESSION_FILE=%REPO_ROOT%\.runtime\launch-session.cmd"
if not exist "%REPO_ROOT%\.runtime" mkdir "%REPO_ROOT%\.runtime"

call "%~dp0preflight-production-env.cmd"

if not defined SIMULATION_MODE set SIMULATION_MODE=true
if not defined SKIP_DEPLOYMENT_SAFETY_GATE set SKIP_DEPLOYMENT_SAFETY_GATE=false
if not defined SKIP_COLD_START_FULL_SWEEP set SKIP_COLD_START_FULL_SWEEP=true

for %%I in ("%LOGFILE%") do set "LOGFILE_ABS=%%~fI"
for %%I in ("%ERRFILE%") do set "ERRFILE_ABS=%%~fI"

> "%SESSION_FILE%" (
  echo @echo off
  echo set "BOT_REPO_ROOT=%REPO_ROOT%"
  echo cd /d "%%BOT_REPO_ROOT%%"
  echo set "NODE_OPTIONS=%NODE_OPTIONS%"
  echo set "RUST_HOTPATH_ENABLED=%RUST_HOTPATH_ENABLED%"
  echo set "SIMULATION_MODE=%SIMULATION_MODE%"
  echo set "SKIP_DEPLOYMENT_SAFETY_GATE=%SKIP_DEPLOYMENT_SAFETY_GATE%"
  echo set "SKIP_COLD_START_FULL_SWEEP=%SKIP_COLD_START_FULL_SWEEP%"
  echo set "USE_START_LIVE=%USE_START_LIVE%"
  echo set "BOT_LOGFILE=%LOGFILE_ABS%"
  echo set "BOT_ERRFILE=%ERRFILE_ABS%"
)

endlocal
exit /b 0
