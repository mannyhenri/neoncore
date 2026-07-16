<#
  One-command NeonCore RUNNER setup for Windows.

  Installs the machine runner so you can launch cartridges on THIS computer from the
  web/mobile portal. Copies the runner + relay to %USERPROFILE%\.neoncore\runner, installs
  deps, writes the config, registers a hidden auto-start Scheduled Task (at logon), and starts it.

  Usage (from the unzipped folder, in PowerShell):
    .\setup.ps1 -Server http://192.168.4.20:4040 -Token SECRET -Repo C:\code\app,C:\code\api

  Params:
    -Server URL        orchestrator URL                                   [required]
    -Token TOK         pairing token (match the server's setting)         [required if server has one]
    -Repo path[,path]  directories this machine may launch in             [at least one]
    -Name NAME         display name for this machine (default: hostname)
    -NoService         install + run in the foreground; skip auto-start
    -Uninstall         remove the auto-start task and exit
#>
param(
  [string]$Server,
  [string]$Token = "",
  [string[]]$Repo = @(),
  [string]$Name = "",
  [switch]$NoService,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
function Info($m) { Write-Host "[runner-setup] $m" -ForegroundColor Cyan }
function Die($m)  { Write-Host "[runner-setup] $m" -ForegroundColor Red; exit 1 }

$InstallDir = Join-Path $env:USERPROFILE ".neoncore\runner"
$RelayDir   = Join-Path $env:USERPROFILE ".neoncore\relay"
$TaskName   = "NeonCore Runner"

if ($Uninstall) {
  schtasks /delete /tn "$TaskName" /f 2>$null | Out-Null
  Info "Runner task removed. Config kept at $InstallDir\runner.config.json"
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js is required (used by the relay). Install Node 18+ then re-run." }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Die "npm is required. Install Node.js (includes npm) then re-run." }
if (-not $Server) { Die "Missing -Server URL (e.g. -Server http://192.168.4.20:4040)" }
if ($Repo.Count -eq 0) { Die "Give at least one -Repo path (a folder this machine may launch in)" }

$Server = $Server.TrimEnd('/')
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Copy runner + relay to a stable home ───────────────────
Info "Installing to $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exclude = @("node_modules", "logs", "runner.config.json")
Get-ChildItem -Path $SourceDir | Where-Object { $exclude -notcontains $_.Name } |
  Copy-Item -Destination $InstallDir -Recurse -Force
$srcRelay = Join-Path (Split-Path -Parent $SourceDir) "relay"
if (Test-Path $srcRelay) {
  New-Item -ItemType Directory -Force -Path $RelayDir | Out-Null
  Get-ChildItem -Path $srcRelay | Where-Object { $_.Name -ne "node_modules" } |
    Copy-Item -Destination $RelayDir -Recurse -Force
}

# ── Install deps ───────────────────────────────────────────
Info "Installing runner dependencies..."
Push-Location $InstallDir; npm install --silent; Pop-Location
if (Test-Path $RelayDir) {
  Info "Installing relay dependencies..."
  Push-Location $RelayDir; npm install --silent; Pop-Location
}

# ── Write config (preserve an existing machineId) ──────────
$cfgPath = Join-Path $InstallDir "runner.config.json"
$machineId = ""
if (Test-Path $cfgPath) {
  try { $machineId = (Get-Content $cfgPath -Raw | ConvertFrom-Json).machineId } catch {}
}
$repos = @($Repo | ForEach-Object { @{ path = $_; name = (Split-Path $_ -Leaf) } })
$cfg = [ordered]@{ serverUrl = $Server; token = $Token; machineId = $machineId; hostname = $Name; repos = $repos }
$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath -Encoding UTF8
Info "Wrote $cfgPath ($($Repo.Count) repo(s))"

if ($NoService) {
  Info "Starting runner in the foreground (Ctrl+C to stop)..."
  node (Join-Path $InstallDir "index.js")
  exit 0
}

# ── Auto-start: hidden VBS launcher + Scheduled Task at logon ─
$nodePath = (Get-Command node).Source
$vbs = Join-Path $InstallDir "run-hidden.vbs"
@"
Set sh = CreateObject("WScript.Shell")
sh.Run """$nodePath"" ""$InstallDir\index.js""", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

Info "Registering Scheduled Task '$TaskName' (runs hidden at logon)..."
schtasks /create /tn "$TaskName" /tr "wscript.exe `"$vbs`"" /sc onlogon /rl LIMITED /f | Out-Null
schtasks /run /tn "$TaskName" | Out-Null
Info "Started. It will relaunch at logon."
Info "Stop/remove:  .\setup.ps1 -Uninstall"
