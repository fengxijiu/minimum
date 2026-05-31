[CmdletBinding()]
param(
    [switch]$NoLink,
    [switch]$Clean,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Show-Usage {
    @"
build-all.ps1 - One-shot build + global registration for `minimum`.

Builds the whole stack in dependency order and exposes the `minimum`
command globally:

  1. Engine (root)  : npm install + tsc + copy-assets  ->  dist/index.js
  2. TUI (tui/)     : npm install + tsc                 ->  tui/dist/cli.js
  3. Register CLI   : npm link                          ->  global `minimum`

Usage:
  .\scripts\build-all.ps1            # full build + global link
  .\scripts\build-all.ps1 -NoLink    # build only, skip global registration
  .\scripts\build-all.ps1 -Clean     # remove dist\ + tui\dist\ first
"@ | Write-Host
}

if ($Help) {
    Show-Usage
    exit 0
}

# Resolve repo root regardless of where the script is invoked from.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
Set-Location $rootDir

$engineDist = Join-Path $rootDir 'dist\index.js'
$tuiDir = Join-Path $rootDir 'tui'
$tuiDist = Join-Path $tuiDir 'dist\cli.js'

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "[STEP] $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "[ OK ] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Fail([string]$Message) {
    throw $Message
}

# NEW: detect the known vitest / coverage-v8 major-version mismatch so we can
# skip the noisy failing install attempt and go straight to --legacy-peer-deps.
function Test-KnownPeerConflict([string]$Prefix) {
    $packageJson = Join-Path $Prefix 'package.json'
    if (-not (Test-Path $packageJson)) {
        return $false
    }

    & node -e @'
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const vitest = deps.vitest;
const coverage = deps["@vitest/coverage-v8"];
const major = (value) => {
    const match = String(value || "").match(/\d+/);
    return match ? match[0] : "";
};
process.exit(vitest && coverage && major(vitest) !== major(coverage) ? 0 : 1);
'@ $packageJson

    return $LASTEXITCODE -eq 0
}

function Invoke-NpmInstallAttempt([string]$Prefix, [switch]$LegacyPeerDeps) {
    $arguments = @('--prefix', $Prefix, 'install')
    if ($LegacyPeerDeps) {
        $arguments += '--legacy-peer-deps'
    }

    & npm @arguments
    if ($LASTEXITCODE -eq 0) {
        return $true
    }

    return $false
}

# Retry install with --legacy-peer-deps because the repo has a known peer-dep conflict.
function Invoke-NpmInstall([string]$Prefix) {
    $preferLegacyPeerDeps = Test-KnownPeerConflict $Prefix

    if ($preferLegacyPeerDeps) {
        Write-Warn "Detected known peer-dep conflict in $Prefix - using --legacy-peer-deps"
        if (Invoke-NpmInstallAttempt $Prefix -LegacyPeerDeps) {
            return
        }
    }
    else {
        if (Invoke-NpmInstallAttempt $Prefix) {
            return
        }

        Write-Warn "Install failed - retrying with --legacy-peer-deps"
        if (Invoke-NpmInstallAttempt $Prefix -LegacyPeerDeps) {
            return
        }
    }

    Write-Warn "Install still failed - clearing node_modules and retrying once"

    $nodeModules = Join-Path $Prefix 'node_modules'

    if (Test-Path $nodeModules) {
        Remove-Item $nodeModules -Recurse -Force
    }

    if ($preferLegacyPeerDeps) {
        if (Invoke-NpmInstallAttempt $Prefix -LegacyPeerDeps) {
            return
        }
    }
    else {
        if (Invoke-NpmInstallAttempt $Prefix) {
            return
        }

        if (Invoke-NpmInstallAttempt $Prefix -LegacyPeerDeps) {
            return
        }
    }

    Fail "npm install failed in $Prefix"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "node is not installed"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm is not installed"
}

$nodeVersion = (& node -v).Trim()
$npmVersion = (& npm -v).Trim()
$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())

if ($nodeMajor -lt 22) {
    Fail "Node >= 22 required (found $nodeVersion)"
}

Write-Ok "Toolchain: node $nodeVersion, npm $npmVersion"

if ($Clean) {
    Write-Step "Cleaning previous build artifacts"

    $distDir = Join-Path $rootDir 'dist'
    $tuiDistDir = Join-Path $tuiDir 'dist'

    if (Test-Path $distDir) {
        Remove-Item $distDir -Recurse -Force
    }

    if (Test-Path $tuiDistDir) {
        Remove-Item $tuiDistDir -Recurse -Force
    }

    Write-Ok "Removed dist\ and tui\dist\"
}

Write-Step "Installing engine dependencies (root)"
Invoke-NpmInstall $rootDir
Write-Ok "Engine dependencies installed"

Write-Step "Building engine -> dist\index.js"
& npm run build
if ($LASTEXITCODE -ne 0) {
    Fail "Engine build failed"
}

if (-not (Test-Path $engineDist)) {
    Fail "Engine build produced no dist\index.js"
}
Write-Ok "Engine built"

Write-Step "Installing TUI dependencies (tui\)"
Invoke-NpmInstall $tuiDir
Write-Ok "TUI dependencies installed"

Write-Step "Building TUI -> tui\dist\cli.js"
& npm --prefix $tuiDir run build
if ($LASTEXITCODE -ne 0) {
    Fail "TUI build failed"
}

if (-not (Test-Path $tuiDist)) {
    Fail "TUI build produced no tui\dist\cli.js"
}
Write-Ok "TUI built"

if (-not $NoLink) {
    Write-Step "Registering global minimum command (npm link)"
    & npm link
    if ($LASTEXITCODE -ne 0) {
        Fail "npm link failed"
    }

    $minimumCommand = Get-Command minimum -ErrorAction SilentlyContinue
    if ($minimumCommand) {
        Write-Ok "minimum registered -> $($minimumCommand.Source)"
    }
    else {
        $globalBin = Join-Path ((& npm prefix -g).Trim()) 'bin'
        Write-Warn "npm link succeeded but minimum is not on PATH."
        Write-Host "  Add npm global bin to PATH: $globalBin" -ForegroundColor Cyan
    }
}
else {
    Write-Step "Skipping global registration (-NoLink)"
}

Write-Host ""
Write-Host "== Build complete ==" -ForegroundColor Green
Write-Host "  engine : $engineDist"
Write-Host "  tui    : $tuiDist"
if (-not $NoLink) {
    Write-Host "  command: run minimum to launch the TUI"
}
else {
    Write-Host "  run    : node bin/minimum-ink.js"
}
Write-Host "  tip    : set MIMO_API_KEY for the live engine (else mock runner)"
