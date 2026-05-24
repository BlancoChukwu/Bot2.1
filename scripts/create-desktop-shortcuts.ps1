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
    Desc = "Live bot: build + dist/src/index.js, SIMULATION_MODE=false"
  },
  @{
    Name = "Aave Liquidator (Production No Gate).lnk"
    Cmd  = "Start Production Bot (No Gate).cmd"
    Icon = 79
    Desc = "Live bot with SKIP_DEPLOYMENT_SAFETY_GATE=true (no PagerDuty/dry-run gate)"
  },
  @{
    Name = "Aave Liquidator (Simulation).lnk"
    Cmd  = "Start Simulation Bot.cmd"
    Icon = 138
    Desc = "Safe mode: build + dist/src/index.js, SIMULATION_MODE=true"
  },
  @{
    Name = "Aave Liquidator (Stop).lnk"
    Cmd  = "Stop Bot.cmd"
    Icon = 131
    Desc = "Stop running bot processes for this repo"
  },
  @{
    Name = "Aave Liquidator (Live ts-node).lnk"
    Cmd  = "Start Live Bot.cmd"
    Icon = 137
    Desc = "Legacy live launcher via npm run start:live (ts-node)"
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
