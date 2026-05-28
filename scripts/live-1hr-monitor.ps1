# Live bot 1-hour run with checkpoint audits and kill-on-critical-error watchdog.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $repo "logs\live-tsnode-$stamp.log"
$errFile = Join-Path $repo "logs\live-tsnode-$stamp.err.log"
$reportFile = Join-Path $repo "logs\live-1hr-report-$stamp.txt"
$watchPollSec = 30

New-Item -ItemType Directory -Force -Path (Join-Path $repo "logs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $repo ".runtime") | Out-Null
node scripts/ensure-single-bot.mjs --stop | Out-Null
@(
  "log=$logFile"
  "err=$errFile"
  "started=$stamp"
  "prefix=live-tsnode"
) | Set-Content (Join-Path $repo "logs\latest-session.txt")

function Write-ReportLine([string]$line) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts  $line" | Tee-Object -FilePath $reportFile -Append
}

function Stop-BotSession([string]$reason) {
  Write-ReportLine "=== STOPPING BOT ($reason) ==="
  node scripts/ensure-single-bot.mjs --stop 2>&1 | ForEach-Object { Write-ReportLine $_ }
  if ($null -ne $script:botProc -and -not $script:botProc.HasExited) {
    try { Stop-Process -Id $script:botProc.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Test-CriticalLogErrors {
  if (-not (Test-Path $logFile)) { return $null }
  $out = node scripts/detect-critical-log-errors.mjs $logFile --offset $script:logOffset 2>&1
  $code = $LASTEXITCODE
  try {
    $parsed = $out | ConvertFrom-Json
    $script:logOffset = [int]$parsed.nextOffset
    if ($code -ne 0 -and $parsed.count -gt 0) { return $parsed }
  } catch {
    Write-ReportLine "critical_watch_parse_failed=$out"
  }
  return $null
}

Write-ReportLine "=== LIVE 1HR RUN START ==="
Write-ReportLine "log=$logFile"
Write-ReportLine "err=$errFile"
Write-ReportLine "critical_watch_poll_sec=$watchPollSec"

$env:SIMULATION_MODE = "false"
$env:NODE_OPTIONS = "--max-old-space-size=650 --expose-gc"
if (-not $env:SKIP_DEPLOYMENT_SAFETY_GATE) {
  Write-ReportLine "safety_gate=enabled (set SKIP_DEPLOYMENT_SAFETY_GATE=1 to bypass dry-run receipt)"
}

$script:logOffset = 0
$script:botProc = Start-Process -FilePath "cmd.exe" -ArgumentList @(
  "/c", "npm run start:live >> `"$logFile`" 2>> `"$errFile`""
) -WorkingDirectory $repo -PassThru -WindowStyle Hidden
Write-ReportLine "bot_pid=$($script:botProc.Id)"

$checkpointsMin = @(5, 20, 35, 50, 60)
$elapsed = 0
$aborted = $false

foreach ($target in $checkpointsMin) {
  $waitSec = ($target - $elapsed) * 60
  $waited = 0
  while ($waited -lt $waitSec -and -not $aborted) {
    $slice = [Math]::Min($watchPollSec, $waitSec - $waited)
    Start-Sleep -Seconds $slice
    $waited += $slice

    $critical = Test-CriticalLogErrors
    if ($null -ne $critical) {
      Write-ReportLine "--- CRITICAL ERROR DETECTED (killing bot) ---"
      Write-ReportLine ($critical | ConvertTo-Json -Compress -Depth 6)
      Stop-BotSession "critical_error"
      $aborted = $true
      break
    }

    $st = node scripts/ensure-single-bot.mjs --status 2>&1 | ConvertFrom-Json
    if ($st.count -eq 0 -and $waited -lt ($waitSec - 60)) {
      $critical = Test-CriticalLogErrors
      if ($null -ne $critical) {
        Write-ReportLine "--- BOT EXITED WITH CRITICAL LOG ---"
        Write-ReportLine ($critical | ConvertTo-Json -Compress -Depth 6)
      } else {
        Write-ReportLine "bot_not_running count=0 (no new critical lines yet)"
      }
    }
  }
  $elapsed = $target
  if ($aborted) { break }

  Write-ReportLine "--- CHECKPOINT ${target}m ---"
  if (Test-Path $logFile) {
    $logBytes = (Get-Item $logFile).Length
    $lineCount = (Get-Content $logFile -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
    Write-ReportLine "log_bytes=$logBytes lines=$lineCount"
  } else {
    Write-ReportLine "log_missing=true"
  }
  if (Test-Path $errFile) {
    $errBytes = (Get-Item $errFile).Length
    if ($errBytes -gt 0) {
      $errTail = Get-Content $errFile -Tail 5 -ErrorAction SilentlyContinue
      Write-ReportLine "err_bytes=$errBytes tail=$($errTail -join ' | ')"
    }
  }

  $critical = Test-CriticalLogErrors
  if ($null -ne $critical) {
    Write-ReportLine "--- CRITICAL ERROR AT CHECKPOINT (killing bot) ---"
    Write-ReportLine ($critical | ConvertTo-Json -Compress -Depth 6)
    Stop-BotSession "critical_error_at_checkpoint"
    $aborted = $true
    break
  }

  try {
    $auditJson = node scripts/audit-session.mjs $logFile 2>&1
    Write-ReportLine $auditJson
  } catch {
    Write-ReportLine "audit_failed=$($_.Exception.Message)"
  }
}

if (-not $aborted) {
  Stop-BotSession "scheduled_end"
}

Write-ReportLine "=== LIVE 1HR RUN END ==="
Write-ReportLine "report=$reportFile"
if ($aborted) { exit 2 }
