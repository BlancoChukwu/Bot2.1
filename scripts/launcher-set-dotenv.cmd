@echo off
rem Sets DOTENV_CONFIG_PATH from repo-relative profile file (arg1). Call before ensure-redis / launcher.
setlocal EnableExtensions
if "%~1"=="" (
  echo Usage: launcher-set-dotenv.cmd ^<env-file^>  Example: .env.simulation
  exit /b 1
)
set "REPO_ROOT=%~dp0.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
set "DOTENV_CONFIG_PATH=%REPO_ROOT%\%~1"
if not exist "%DOTENV_CONFIG_PATH%" (
  echo env_file_missing: %DOTENV_CONFIG_PATH%
  echo Run: node scripts\bootstrap-env-profiles.mjs
  exit /b 1
)
endlocal & set "DOTENV_CONFIG_PATH=%DOTENV_CONFIG_PATH%" & set "BOT_ENV_FILE=%~1"
