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

.PARAMETER FleetToken
    Join an existing fleet of NeonCore servers. Saved on first launch, so you pass
    it once and every later `npm start` keeps it. Without it this machine mints its
    OWN token and cannot talk to your other servers - they reject each other with 401.

.PARAMETER Peer
    Address of a server already in the fleet, e.g. http://desktop.local:4040.
    One introduction in one direction is enough; gossip does the rest.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-neoncore.ps1 -Start `
      -FleetToken abc123 -Peer http://desktop.local:4040
#>

[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$NoStart,
    [switch]$Dev,
    [string]$FleetToken,
    [string]$Peer
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

# Persisted by the server on first launch (see server/src/lib/auth.ts), so this is a
# one-time flag rather than something to remember on every start.
if ($FleetToken) { $env:NEONCORE_FLEET_TOKEN = $FleetToken }

# Introducing ONE server to another is enough: gossip teaches the rest of the fleet about
# this machine within a tick, and teaches this machine about everyone else.
function Start-PeerSeed {
    if (-not $Peer) { return }
    $tok = $env:NEONCORE_FLEET_TOKEN
    $peerUrl = $Peer
    # Honour PORT. Hardcoding 4040 meant a server on any other port never joined, and the
    # background job timed out with nothing in the foreground to say so.
    $selfPort = if ($env:PORT) { $env:PORT } elseif ($env:NEONCORE_PORT) { $env:NEONCORE_PORT } else { "4040" }
    Start-Job -ScriptBlock {
        param($peerUrl, $tok, $selfPort)
        for ($i = 0; $i -lt 60; $i++) {
            try {
                Invoke-RestMethod -Uri "http://localhost:$selfPort/api/health" -TimeoutSec 2 | Out-Null
                $headers = @{ "Content-Type" = "application/json" }
                if ($tok) { $headers["Authorization"] = "Bearer $tok" }
                Invoke-RestMethod -Uri "http://localhost:$selfPort/api/peers" -Method Post `
                    -Headers $headers -Body (@{ url = $peerUrl } | ConvertTo-Json) -TimeoutSec 5 | Out-Null
                return
            } catch { Start-Sleep -Seconds 1 }
        }
    } -ArgumentList $peerUrl, $tok, $selfPort | Out-Null
    Info "Will join the fleet via $Peer once the server is up."
}

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
    Start-PeerSeed
    & $npm.Source run dev
} elseif ($NoStart) {
    Info "Not starting. Launch it anytime with:  npm start"
    if ($Peer) { Info "Add $Peer from the dashboard's fleet panel once it is running." }
} elseif ($Start) {
    Info "Starting server (Ctrl-C to stop)..."
    Start-PeerSeed
    & $npm.Source start
} else {
    $ans = Read-Host "  Start the NeonCore server now? [Y/n]"
    if ($ans -match '^[Nn]') {
        Info "Not starting. Launch it anytime with:  npm start"
    } else {
        Info "Starting server (Ctrl-C to stop)..."
        Start-PeerSeed
        & $npm.Source start
    }
}
