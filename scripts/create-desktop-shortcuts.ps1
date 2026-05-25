# Creates Desktop shortcuts to the repo launcher .cmd files.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\create-desktop-shortcuts.ps1

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktop = [Environment]::GetFolderPath("Desktop")
$shell = New-Object -ComObject WScript.Shell

$launchers = @(
  @{
    Name = "Aave Liquidator (Production).lnk"
    Cmd  = "Start Production Bot.cmd"
    Icon = 137
    Desc = "Live: dist build, SIMULATION_MODE=false, safety gate ON, detached + logs"
  },
  @{
    Name = "Aave Liquidator (Production No Gate).lnk"
    Cmd  = "Start Production Bot (No Gate).cmd"
    Icon = 79
    Desc = "Live: dist build, SKIP_DEPLOYMENT_SAFETY_GATE=true, detached + logs"
  },
  @{
    Name = "Aave Liquidator (Simulation).lnk"
    Cmd  = "Start Simulation Bot.cmd"
    Icon = 138
    Desc = "Soak: dist build, SIMULATION_MODE=true, event watchlist, detached 2h+ logs"
  },
  @{
    Name = "Aave Liquidator (Stop).lnk"
    Cmd  = "Stop Bot.cmd"
    Icon = 131
    Desc = "Stop bot processes and clear stale .runtime\bot.lock"
  },
  @{
    Name = "Aave Liquidator (Live ts-node).lnk"
    Cmd  = "Start Live Bot.cmd"
    Icon = 137
    Desc = "Live dev: npm run start:live (ts-node), safety gate ON, detached + logs"
  }
)

foreach ($entry in $launchers) {
  $cmdPath = Join-Path $repoRoot $entry.Cmd
  if (-not (Test-Path $cmdPath)) {
    Write-Warning "Skipping missing launcher: $($entry.Cmd)"
    continue
  }
  $shortcutPath = Join-Path $desktop $entry.Name
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $cmdPath
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.Description = $entry.Desc
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,$($entry.Icon)"
  $shortcut.Save()
  Write-Host "Created: $shortcutPath"
}

Write-Host ""
Write-Host "Desktop shortcuts installed. Repo: $repoRoot"
