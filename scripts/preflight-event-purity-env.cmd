@echo off
rem Event-purity profile checks (WS Flashblocks + execution RPC). Requires DOTENV_CONFIG_PATH.
if "%DOTENV_CONFIG_PATH%"=="" (
  echo preflight_event_purity: DOTENV_CONFIG_PATH not set
  exit /b 1
)
node "%~dp0preflight-event-purity-env.mjs" "%DOTENV_CONFIG_PATH%"
exit /b %ERRORLEVEL%
