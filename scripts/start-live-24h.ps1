# Shadow-validation live session — always exactly one bot process.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

New-Item -ItemType Directory -Force -Path logs,.runtime | Out-Null

Write-Host "Stopping any existing bot instances..."
node scripts/ensure-single-bot.mjs --stop | Out-Host

node scripts/emit-dry-run-receipt.mjs --live | Out-Null
$r = Get-Content .runtime/dry-run-receipt.json | ConvertFrom-Json

$env:MIN_LIQUIDATION_DEBT_USD = "50"
$env:LOG_ARB_DEBUG = "false"
$env:SIMULATION_MODE = "false"
$env:DRY_RUN_SUCCESS = "true"
$env:DRY_RUN_VALIDATED_AT_MS = $r.validatedAtMs
$env:DRY_RUN_CONFIG_HASH = $r.configHash
$env:NODE_OPTIONS = "--max-old-space-size=650 --expose-gc"

$log = "logs/live-24h-20260521.log"
$errLog = "logs/live-24h-20260521.err.log"
Write-Host "Starting single bot instance via PM2; session logs at $log"

node scripts/pm2-bot-launch.mjs --output $log --error $errLog | Out-Host

Start-Sleep -Seconds 8
$st = node scripts/ensure-single-bot.mjs --status | ConvertFrom-Json
if ($st.count -ne 1) {
  Write-Error "Expected exactly 1 bot process, found $($st.count): $($st.botProcesses | ConvertTo-Json -Compress)"
}
Write-Host "Bot running. lockPid=$($st.lockPid) processes=$($st.count)"
