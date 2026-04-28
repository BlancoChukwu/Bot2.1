@echo off
title Optimism Aave V3 Live Liquidation Bot
cd /d "%~dp0"
echo Starting LIVE Optimism Aave V3 liquidation bot...
echo.
echo WARNING: This runs with SIMULATION_MODE=false.
echo Press Ctrl+C in this window to stop the bot.
echo.
npm run start:live
echo.
echo Bot process exited. Press any key to close this window.
pause >nul
