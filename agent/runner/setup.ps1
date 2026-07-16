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
  [string[]]$Scan = @(),
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
if (-not $Server) { Die "Missing -Server URL (e.g. -Server http://Mannys-Mac-Pro.local:4040)" }

# Resolve the repo allowlist: -Repo, -Scan (git repos under a dir), then an interactive prompt.
$repos = New-Object System.Collections.Generic.List[string]
foreach ($r in $Repo) { if ($r) { $repos.Add($r.TrimEnd('\','/')) } }
function Add-Scan($dir) {
  if (-not (Test-Path $dir)) { Write-Host "[runner-setup] Scan skipped (no such dir): $dir" -ForegroundColor Yellow; return }
  Get-ChildItem -Path $dir -Directory | Where-Object { Test-Path (Join-Path $_.FullName ".git") } |
    ForEach-Object { $repos.Add($_.FullName) }
}
foreach ($s in $Scan) { Add-Scan $s }
if ($repos.Count -eq 0) {
  Write-Host ""
  Info "Which folders should this machine give NeonCore access to?"
  Write-Host "  Enter directories to expose, comma-separated. You can give:"
  Write-Host "    - individual repos:  C:\code\app, C:\code\api"
  Write-Host "    - a parent to scan:  scan:C:\code   (adds every git repo under it)"
  $answer = Read-Host "  Folders"
  foreach ($part in ($answer -split ',')) {
    $p = $part.Trim()
    if (-not $p) { continue }
    if ($p -like 'scan:*') { Add-Scan ($p.Substring(5)) } else { $repos.Add($p.TrimEnd('\','/')) }
  }
}
$Repo = @($repos | Select-Object -Unique)
if ($Repo.Count -eq 0) { Die "No folders selected. Pass -Repo path / -Scan path, or answer the prompt." }
Info "Exposing $($Repo.Count) folder(s):"
$Repo | ForEach-Object { Write-Host "    - $_" }

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
# Bundle the hooks installer (status/activity/approvals) so the runner is self-contained.
$AgentDir = Join-Path $env:USERPROFILE ".neoncore\agent"
$srcAgent = Join-Path (Split-Path -Parent $SourceDir) "agent"          # zip: runner/ + agent/ siblings
if (-not (Test-Path (Join-Path $srcAgent "install.py"))) { $srcAgent = Split-Path -Parent $SourceDir }  # in-repo: agent/runner -> agent/
if (Test-Path (Join-Path $srcAgent "install.py")) {
  New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
  Get-ChildItem -Path $srcAgent | Where-Object { $_.Name -ne "__pycache__" } |
    Copy-Item -Destination $AgentDir -Recurse -Force
}

# ── Install deps ───────────────────────────────────────────
Info "Installing runner dependencies..."
Push-Location $InstallDir; npm install --silent; Pop-Location
if (Test-Path $RelayDir) {
  Info "Installing relay dependencies..."
  Push-Location $RelayDir; npm install --silent; Pop-Location
}

# ── Install Claude Code hooks (status / activity / approvals) — global, one-time ──
$hooksPy = Join-Path $AgentDir "install.py"
if (Test-Path $hooksPy) {
  $py = (Get-Command python -ErrorAction SilentlyContinue) ?? (Get-Command python3 -ErrorAction SilentlyContinue)
  if ($py) {
    Info "Installing NeonCore hooks (status/activity/approvals)..."
    & $py.Source $hooksPy --url $Server 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Info "Hooks installed." }
    else { Write-Host "[runner-setup] Hook installer reported an error — cartridges still launch, but without live status/approvals." -ForegroundColor Yellow }
  } else {
    Write-Host "[runner-setup] Python not found — skipping hooks. Cartridges launch but won't report status/approvals. Install Python 3 and re-run." -ForegroundColor Yellow
  }
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
