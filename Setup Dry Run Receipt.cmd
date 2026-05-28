@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo  Dry-run receipt (deployment safety gate)
echo ========================================
echo.
echo Refreshes DRY_RUN_* in .env from current config (live mode hash).
echo Starts local Redis when REDIS_URL points at 127.0.0.1 (portable .runtime\redis).
echo Receipt is valid for ~15 minutes — launch production soon after.
echo.

echo Ensuring Redis is up...
call node scripts\ensure-redis.mjs
if errorlevel 1 (
  echo Redis failed to start. Fix REDIS_URL or start .runtime\redis\redis-server.exe manually.
  pause
  exit /b 1
)

call scripts\build-dist.cmd
if errorlevel 1 exit /b 1

node scripts\emit-dry-run-receipt.mjs --live
if errorlevel 1 (
  echo emit-dry-run-receipt failed.
  exit /b 1
)

node scripts\apply-dry-run-receipt-to-env.mjs
if errorlevel 1 (
  echo apply-dry-run-receipt-to-env failed.
  exit /b 1
)

echo.
echo Done. Receipt: .runtime\dry-run-receipt.json
echo Next: double-click "Aave Liquidator (Production)" within 15 minutes.
echo.
pause
endlocal
