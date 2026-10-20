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

# Interactive folder browser - start at the home folder and drill down; scan or add as you go.
function Pick-Folders {
  $cwd = $env:USERPROFILE
  while ($true) {
    $dirs = @(Get-ChildItem -Path $cwd -Directory -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '.*' } | Sort-Object Name)
    Write-Host ""
    Write-Host "[dir] $cwd   (selected so far: $($repos.Count))" -ForegroundColor Cyan
    for ($i = 0; $i -lt $dirs.Count; $i++) {
      $mark = ""
      if (Test-Path (Join-Path $dirs[$i].FullName ".git")) { $mark = "  * git repo" }
      Write-Host ("  {0,3}) {1}{2}" -f ($i + 1), $dirs[$i].Name, $mark)
    }
    if ($dirs.Count -eq 0) { Write-Host "  (no subfolders here)" }
    Write-Host "  ---"
    Write-Host "  #  enter that folder   |   u  up a level"
    Write-Host "  s  SCAN here (add every git repo)   |   a  ADD this folder   |   d  done"
    $choice = (Read-Host "  >").Trim()
    switch -Regex ($choice) {
      '^[uU]$' { $p = Split-Path -Parent $cwd; if ($p) { $cwd = $p } }
      '^[sS]$' { $before = $repos.Count; Add-Scan $cwd; Info "Scanned $cwd -> added $($repos.Count - $before) repo(s)" }
      '^[aA]$' { $repos.Add($cwd.TrimEnd('\','/')); Info "Added $cwd" }
      '^[dD]$' { return }
      '^\d+$'  {
        $idx = [int]$choice
        if ($idx -ge 1 -and $idx -le $dirs.Count) { $cwd = $dirs[$idx - 1].FullName }
        else { Write-Host "  Out of range." -ForegroundColor Yellow }
      }
      default  { Write-Host "  Enter a number, or u / s / a / d." -ForegroundColor Yellow }
    }
  }
}

if ($repos.Count -eq 0) {
  Info "No folders given - let's pick which ones this machine exposes."
  Write-Host "  Browse from your home folder, drill in, then SCAN it (add every git repo inside)"
  Write-Host "  or ADD it directly. Repeat as needed, then press d."
  Pick-Folders
}
$Repo = @($repos | Select-Object -Unique)
if ($Repo.Count -eq 0) { Die "No folders selected. Pass -Repo path / -Scan path, or answer the prompt." }
Info "Exposing $($Repo.Count) folder(s):"
$Repo | ForEach-Object { Write-Host "    - $_" }

$Server = $Server.TrimEnd('/')
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# -- Copy runner + relay to a stable home -------------------
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
# The runner and relay import ..\lib\*.mjs, so lib lives beside them (~\.neoncore\lib);
# without it both die on start with ERR_MODULE_NOT_FOUND.
$srcLib = Join-Path (Split-Path -Parent $SourceDir) "lib"
if (Test-Path $srcLib) {
  $LibDir = Join-Path $env:USERPROFILE ".neoncore\lib"
  New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
  Get-ChildItem -Path $srcLib | Copy-Item -Destination $LibDir -Recurse -Force
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

# -- Install deps -------------------------------------------
Info "Installing runner dependencies..."
Push-Location $InstallDir; npm install --silent; Pop-Location
if (Test-Path $RelayDir) {
  Info "Installing relay dependencies..."
  Push-Location $RelayDir; npm install --silent; Pop-Location
}

# -- Install Claude Code hooks (status / activity / approvals) - global, one-time --
$hooksPy = Join-Path $AgentDir "install.py"
if (Test-Path $hooksPy) {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
  if ($py) {
    Info "Installing NeonCore hooks (status/activity/approvals)..."
    # Hooks are optional: a failure here must not abort the runner install. Redirecting
    # a native command's stderr inside PowerShell wraps each line in a NativeCommandError
    # which, under $ErrorActionPreference="Stop", terminates setup before the config is
    # ever written -- even when the command exits 0. Redirect inside cmd instead so
    # PowerShell never sees the stderr stream, and gate purely on the exit code.
    $hookLog  = Join-Path $env:TEMP "neoncore-hooks-install.log"
    $prevEAP  = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & cmd /c "`"$($py.Source)`" `"$hooksPy`" --url `"$Server`" > `"$hookLog`" 2>&1"
      $hookExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEAP
    }
    if ($hookExit -eq 0) { Info "Hooks installed." }
    else {
      Write-Host "[runner-setup] Hook installer reported an error (exit $hookExit) - cartridges still launch, but without live status/approvals." -ForegroundColor Yellow
      Write-Host "[runner-setup] Details: $hookLog" -ForegroundColor Yellow
    }
  } else {
    Write-Host "[runner-setup] Python not found - skipping hooks. Cartridges launch but won't report status/approvals. Install Python 3 and re-run." -ForegroundColor Yellow
  }
}

# -- Write config (preserve an existing machineId) ----------
$cfgPath = Join-Path $InstallDir "runner.config.json"
$machineId = ""
if (Test-Path $cfgPath) {
  try { $machineId = (Get-Content $cfgPath -Raw | ConvertFrom-Json).machineId } catch {}
}
$repos = @($Repo | ForEach-Object { @{ path = $_; name = (Split-Path $_ -Leaf) } })
$cfg = [ordered]@{ serverUrl = $Server; token = $Token; machineId = $machineId; hostname = $Name; repos = $repos }
# Write UTF-8 *without* a BOM. Set-Content -Encoding UTF8 on PowerShell 5.1 emits a
# leading U+FEFF, which Node's JSON.parse rejects -- the runner would exit 1 on startup
# and never register. (utf8NoBOM is PS7-only, so go through .NET for 5.1 compatibility.)
$json = $cfg | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Info "Wrote $cfgPath ($($Repo.Count) repo(s))"

if ($NoService) {
  Info "Starting runner in the foreground (Ctrl+C to stop)..."
  node (Join-Path $InstallDir "index.js")
  exit 0
}

# -- Auto-start: hidden VBS launcher + Scheduled Task at logon -
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
