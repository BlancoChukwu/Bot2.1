@echo off
setlocal EnableExtensions
title Aave Liquidator - Stop
cd /d "%~dp0"

echo Stopping bot processes for this repo...
node scripts\ensure-single-bot.mjs --stop
echo.
node scripts\ensure-single-bot.mjs --status
echo.
pause
endlocal
