<#
.SYNOPSIS
    One-shot NeonCore AGENT setup for a Windows machine.

.DESCRIPTION
    Connects THIS machine to an existing NeonCore server: installs the Claude Code
    hooks, builds the relay, and launches a bare-terminal Claude Code session that
    shows up as a cartridge in the dashboard.

    It first copies the agent files to a stable home (%USERPROFILE%\.neoncore\agent)
    and installs from there, so you can safely run this from Downloads/Desktop and
    delete the download afterward without breaking the hooks.

.PARAMETER ServerUrl
    Full orchestrator URL, e.g. http://192.168.4.20:4040

.PARAMETER ServerIp
    Server LAN IP, e.g. 192.168.4.20 (combined with -Port).

.PARAMETER Port
    Server port. Default 4040.

.PARAMETER RepoPath
    Folder the relay's Claude Code session should run in. Default: current directory.

.PARAMETER AgentType
    Agent type to register as. Default: claude.

.PARAMETER Trust
    Auto-approve this agent's permissions (skips manual dashboard approval).

.PARAMETER SkipHooks
    Don't install the Claude Code hooks.

.PARAMETER SkipRelay
    Install/verify only; don't launch the relay.

.EXAMPLE
    .\bootstrap.ps1 -RepoPath C:\code\my-project

.EXAMPLE
    .\bootstrap.ps1 -ServerIp 192.168.4.20 -Trust
#>

[CmdletBinding()]
param(
    [string]$ServerUrl,
    [string]$ServerIp,
    [int]$Port = 4040,
    [string]$RepoPath = (Get-Location).Path,
    [string]$AgentType = "claude",
    [switch]$Trust,
    [switch]$SkipHooks,
    [switch]$SkipRelay
)

$ErrorActionPreference = "Stop"

function Info($m)  { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)    { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "  !   $m" -ForegroundColor Yellow }
function Die($m)   { Write-Host "  X   $m" -ForegroundColor Red; exit 1 }

# Known-good server for this network; discovery tries this first.
$DefaultServerIp = "192.168.4.20"

# Returns $true if a NeonCore orchestrator answers at http://$ip:$port.
function Test-NeonCore([string]$ip, [int]$port, [int]$timeoutSec = 2) {
    try {
        Invoke-RestMethod -Uri "http://${ip}:${port}/api/agents" -TimeoutSec $timeoutSec | Out-Null
        return $true
    } catch { return $false }
}

# Finds the orchestrator IP: known default first, then a quick scan of this
# machine's local /24 subnet(s) for anything answering on $port.
function Find-NeonCoreServer([int]$port) {
    Info "Trying known server $DefaultServerIp ..."
    if (Test-NeonCore $DefaultServerIp $port) { return $DefaultServerIp }

    Warn "$DefaultServerIp did not answer - scanning the local network..."
    $prefixes = @()
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        ForEach-Object {
            $p = ($_.IPAddress -split '\.')[0..2] -join '.'
            if ($prefixes -notcontains $p) { $prefixes += $p }
        }

    foreach ($prefix in $prefixes) {
        Info "Probing ${prefix}.0/24 on port $port ..."
        $pending = foreach ($h in 1..254) {
            $ip = "${prefix}.$h"
            $c  = New-Object System.Net.Sockets.TcpClient
            $ar = $c.BeginConnect($ip, $port, $null, $null)
            [pscustomobject]@{ Ip = $ip; Client = $c; Async = $ar }
        }
        Start-Sleep -Milliseconds 800
        $open = foreach ($x in $pending) {
            $isOpen = $x.Async.AsyncWaitHandle.WaitOne(0) -and $x.Client.Connected
            try { $x.Client.Close() } catch {}
            if ($isOpen) { $x.Ip }
        }
        foreach ($ip in $open) {
            if (Test-NeonCore $ip $port) { return $ip }
        }
    }
    return $null
}

Write-Host ""
Write-Host "NeonCore Agent Bootstrap (Windows)" -ForegroundColor Magenta
Write-Host "==================================" -ForegroundColor Magenta
Write-Host ""

# --- Relocate agent files to a stable home ------------------------------------
# Hook commands bake in absolute paths; installing from a throwaway location
# (Downloads/Desktop, an extracted zip) breaks them the moment it's removed.
# Copy to %USERPROFILE%\.neoncore\agent and install from there.
$SourceDir  = $PSScriptRoot
$InstallDir = Join-Path $env:USERPROFILE ".neoncore\agent"
if ($SourceDir -ne $InstallDir) {
    Info "Installing agent files to $InstallDir"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Get-ChildItem -Path $SourceDir -Recurse -File |
        Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\__pycache__\\' } |
        ForEach-Object {
            $rel  = $_.FullName.Substring($SourceDir.Length).TrimStart('\')
            $dest = Join-Path $InstallDir $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
            Copy-Item $_.FullName -Destination $dest -Force
        }
}
$AgentDir  = $InstallDir
$InstallPy = Join-Path $AgentDir "install.py"
$RelayDir  = Join-Path $AgentDir "relay"
$RelayJs   = Join-Path $RelayDir "index.js"
Write-Host ""

# --- Resolve the orchestrator URL ---------------------------------------------
if (-not $ServerUrl) {
    if (-not $ServerIp) {
        Write-Host "Locating the NeonCore server..." -ForegroundColor White
        $ServerIp = Find-NeonCoreServer $Port
        if ($ServerIp) {
            Ok "Found orchestrator at $ServerIp"
        } else {
            Warn "Auto-discovery failed."
            $ServerIp = Read-Host "Enter the NeonCore server LAN IP (default $DefaultServerIp)"
            if (-not $ServerIp) { $ServerIp = $DefaultServerIp }
        }
        Write-Host ""
    }
    $ServerUrl = "http://${ServerIp}:${Port}"
}
$ServerUrl = $ServerUrl.TrimEnd("/")

Info "Orchestrator : $ServerUrl"
Info "Agent home   : $AgentDir"
Info "Repo (relay) : $RepoPath"
Info "Agent type   : $AgentType"
Info "Trust mode   : $(if ($Trust) { 'enabled (auto-approve)' } else { 'disabled (manual approval)' })"
Write-Host ""

$env:NEONCORE_URL = $ServerUrl
$env:NEONCORE_AGENT_TYPE = $AgentType
if ($Trust) { $env:NEONCORE_TRUST = "1" }

# --- Step 1: connectivity check -----------------------------------------------
Write-Host "[1/4] Checking connectivity to the orchestrator..." -ForegroundColor White
try {
    Invoke-RestMethod -Uri "$ServerUrl/api/agents" -TimeoutSec 8 | Out-Null
    Ok "Reachable."
} catch {
    Warn "Could not reach $ServerUrl/api/agents"
    Warn "Check: server running, same subnet, port $Port open. Continuing anyway."
}
Write-Host ""

# --- Step 2: install hooks ----------------------------------------------------
Write-Host "[2/4] Installing Claude Code hooks..." -ForegroundColor White
if ($SkipHooks) {
    Info "Skipped (-SkipHooks)."
} else {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
    if (-not $python) {
        Warn "Python 3 not found - skipping hooks. Install from https://python.org,"
        Warn "then re-run this script."
    } elseif (-not (Test-Path $InstallPy)) {
        Warn "install.py not found in agent home - skipping hooks."
    } else {
        & $python.Source $InstallPy --url $ServerUrl
        if ($LASTEXITCODE -ne 0) { Warn "Hook installer exited with code $LASTEXITCODE." }
        else { Ok "Hooks installed into your Claude settings." }
    }
}
Write-Host ""

# --- Step 3: relay prerequisites ----------------------------------------------
Write-Host "[3/4] Preparing the relay..." -ForegroundColor White
$node = Get-Command node -ErrorAction SilentlyContinue
$npm  = Get-Command npm  -ErrorAction SilentlyContinue
if ($SkipRelay) {
    Info "Skipped (-SkipRelay)."
} elseif (-not $node) {
    Warn "Node.js not found - install from https://nodejs.org to use the relay."
    $SkipRelay = $true
} elseif (-not (Test-Path $RelayJs)) {
    Warn "relay\index.js not found - skipping relay."
    $SkipRelay = $true
} else {
    if (-not (Test-Path (Join-Path $RelayDir "node_modules"))) {
        Info "Installing relay dependencies (builds node-pty; may need VS C++ Build Tools)..."
        Push-Location $RelayDir
        try { & $npm.Source install } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) {
            Warn "npm install failed. Install the 'Desktop development with C++' workload"
            Warn "(Visual Studio Build Tools), then re-run this script."
            $SkipRelay = $true
        } else { Ok "Relay dependencies ready." }
    } else {
        Ok "Relay dependencies already present."
    }
}
Write-Host ""

# --- Resolve the Claude Code CLI the relay will launch ------------------------
if (-not $SkipRelay -and -not $env:NEONCORE_AGENT_CMD) {
    $claude = $null
    foreach ($name in @('claude.cmd', 'claude.exe', 'claude')) {
        $c = Get-Command $name -ErrorAction SilentlyContinue
        if ($c -and $c.Source) { $claude = $c.Source; break }
    }
    if ($claude) {
        $env:NEONCORE_AGENT_CMD = $claude
        Ok "Claude CLI: $claude"
    } else {
        Warn "Claude Code CLI ('claude') not found on PATH - cannot start a session."
        Warn "Install it (you already have Node):  npm install -g @anthropic-ai/claude-code"
        Warn "Then re-run this script."
        $SkipRelay = $true
    }
}
Write-Host ""

# --- Step 4: launch the relay -------------------------------------------------
Write-Host "[4/4] Launching the relay..." -ForegroundColor White
if ($SkipRelay) {
    Info "Not launching. To start a session later, run from inside your repo:"
    Info "  `$env:NEONCORE_URL='$ServerUrl'; node `"$RelayJs`""
} else {
    if (-not (Test-Path $RepoPath)) { Die "Repo path does not exist: $RepoPath" }
    Ok "Starting Claude Code in $RepoPath - NeonCore can now dispatch to this session."
    Info "Tip: relaunch anytime with:  `$env:NEONCORE_URL='$ServerUrl'; node `"$RelayJs`""
    Write-Host ""
    Push-Location $RepoPath
    try {
        & $node.Source $RelayJs
    } finally {
        Pop-Location
    }
}
