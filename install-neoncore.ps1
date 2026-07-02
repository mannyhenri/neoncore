<#
.SYNOPSIS
    Full NeonCore installer for Windows.

.DESCRIPTION
    Installs and builds the NeonCore server + dashboard from this repo, then
    (optionally) starts it. Run from the repo root - e.g. inside the folder
    extracted from neoncore-full.zip, or a fresh `git clone`.

    Because PowerShell blocks unsigned scripts by default, launch it as:
      powershell -ExecutionPolicy Bypass -File .\install-neoncore.ps1

.PARAMETER Start
    Install, build, and start the server without prompting.

.PARAMETER NoStart
    Install and build only.

.PARAMETER Dev
    Install, then run hot-reload dev mode.
#>

[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$NoStart,
    [switch]$Dev
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !   $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  X   $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "NeonCore Full Installer (Windows)" -ForegroundColor Magenta
Write-Host "=================================" -ForegroundColor Magenta
Write-Host ""

# --- Sanity: are we in the repo? ----------------------------------------------
if (-not (Test-Path (Join-Path $Root "package.json"))) {
    Die "package.json not found - run this from the NeonCore repo root."
}

# --- Prerequisites ------------------------------------------------------------
Write-Host "[1/4] Checking prerequisites..." -ForegroundColor White
$node = Get-Command node -ErrorAction SilentlyContinue
$npm  = Get-Command npm  -ErrorAction SilentlyContinue
if (-not $node) { Die "Node.js not found. Install Node 18+ from https://nodejs.org" }
if (-not $npm)  { Die "npm not found. It ships with Node.js." }
$nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 18) { Die "Node 18+ required (found $(node -v))." }
Ok "Node $(node -v), npm $(npm -v)"
Write-Host ""

# --- Install dependencies -----------------------------------------------------
Write-Host "[2/4] Installing dependencies (npm install)..." -ForegroundColor White
& $npm.Source install
if ($LASTEXITCODE -ne 0) { Die "npm install failed." }
Ok "Dependencies installed."
Write-Host ""

# --- Build --------------------------------------------------------------------
Write-Host "[3/4] Building dashboard + server (npm run build)..." -ForegroundColor White
& $npm.Source run build
if ($LASTEXITCODE -ne 0) { Die "Build failed." }
Ok "Build complete (dashboard bundled into server/public)."
Write-Host ""

# --- Report the URLs ----------------------------------------------------------
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host "[4/4] Ready." -ForegroundColor White
Ok "Local:    http://localhost:4040"
if ($lanIp) { Ok "Network:  http://${lanIp}:4040   (agents connect here)" }
Write-Host ""
Info "Agents on other machines connect with the agent package (bootstrap.ps1 /"
Info "bootstrap.sh), pointing at the Network URL above. See INSTALL.md."
Write-Host ""

# --- Start --------------------------------------------------------------------
if ($Dev) {
    Info "Starting dev mode with hot reload (Ctrl-C to stop)..."
    & $npm.Source run dev
} elseif ($NoStart) {
    Info "Not starting. Launch it anytime with:  npm start"
} elseif ($Start) {
    Info "Starting server (Ctrl-C to stop)..."
    & $npm.Source start
} else {
    $ans = Read-Host "  Start the NeonCore server now? [Y/n]"
    if ($ans -match '^[Nn]') {
        Info "Not starting. Launch it anytime with:  npm start"
    } else {
        Info "Starting server (Ctrl-C to stop)..."
        & $npm.Source start
    }
}
