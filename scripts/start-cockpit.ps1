# One-click Liquidator Cockpit launcher (Windows).
# - Fixes SSH key ACLs (OpenSSH equivalent of chmod 600)
# - Verifies ssh is on PATH
# - Starts the Tauri desktop app (dev) or a built release binary if present
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-cockpit.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-cockpit.ps1 -Release

[CmdletBinding()]
param(
  [switch]$Release,
  [string]$SshKeyPath = "C:\Users\brick\Downloads\ssh-key-2026-05-29 (1).key"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot "cockpit\package.json"))) {
  # Script lives in <repo>/scripts — parent is repo root.
  $RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
}

$CockpitDir = Join-Path $RepoRoot "cockpit"
Write-Host "Cockpit root: $CockpitDir" -ForegroundColor Cyan

function Ensure-SshKeyAcl {
  param([string]$KeyPath)
  if (-not (Test-Path -LiteralPath $KeyPath)) {
    Write-Warning "SSH key not found at: $KeyPath"
    Write-Warning "Set the path in the Connection panel after launch, or pass -SshKeyPath."
    return
  }

  Write-Host "Hardening SSH key ACL (OpenSSH requires restrictive permissions)..." -ForegroundColor Yellow
  # Equivalent to chmod 600: remove inheritance, grant current user Read only.
  & icacls $KeyPath /inheritance:r | Out-Null
  & icacls $KeyPath /grant:r "${env:USERNAME}:(R)" | Out-Null
  Write-Host "ACL updated for: $KeyPath" -ForegroundColor Green
}

function Assert-SshOnPath {
  $ssh = Get-Command ssh -ErrorAction SilentlyContinue
  if (-not $ssh) {
    throw "ssh not found on PATH. Install Windows OpenSSH Client (Optional Features) and retry."
  }
  Write-Host "ssh: $($ssh.Source)" -ForegroundColor Green
}

Ensure-SshKeyAcl -KeyPath $SshKeyPath
Assert-SshOnPath

Set-Location $CockpitDir

if (-not (Test-Path (Join-Path $CockpitDir "node_modules"))) {
  Write-Host "Installing cockpit npm dependencies..." -ForegroundColor Yellow
  npm install
}

$ReleaseExeCandidates = @(
  (Join-Path $CockpitDir "src-tauri\target\release\liquidator-cockpit.exe"),
  (Join-Path $CockpitDir "src-tauri\target\release\Liquidator Cockpit.exe")
)

if ($Release) {
  $exe = $ReleaseExeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) {
    Write-Host "No release binary found. Building (npm run tauri:build)..." -ForegroundColor Yellow
    npm run tauri:build
    $exe = $ReleaseExeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  if (-not $exe) {
    throw "Release build finished but executable was not found under src-tauri/target/release."
  }
  Write-Host "Launching release binary: $exe" -ForegroundColor Cyan
  Start-Process -FilePath $exe
  return
}

Write-Host "Starting Tauri desktop cockpit (dev)..." -ForegroundColor Cyan
Write-Host "After the window opens: click CONNECT once to start live telemetry." -ForegroundColor DarkGray
npm run tauri:dev
