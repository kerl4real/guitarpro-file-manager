# Build and install the manager and its parser for local use.
# Close Guitar Pro File Manager before running this script.
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\GuitarProFileManager'),
    [string]$ParserDirectory = (Join-Path $PSScriptRoot '..\guitarpro-file-parser')
)

$ErrorActionPreference = 'Stop'

try {
    Get-Command cargo -ErrorAction Stop | Out-Null
    $parserRoot = (Resolve-Path -LiteralPath $ParserDirectory).Path
    $managerRoot = $PSScriptRoot
    foreach ($root in @($parserRoot, $managerRoot)) {
        if (-not (Test-Path -LiteralPath (Join-Path $root 'Cargo.toml') -PathType Leaf)) {
            throw "No Cargo.toml found in $root"
        }
    }

    # Explicit target directories keep artifact paths predictable with Cargo overrides.
    Write-Host 'Building release parser...'
    & cargo build --release --locked --manifest-path (Join-Path $parserRoot 'Cargo.toml') --target-dir (Join-Path $parserRoot 'target') -p cli
    if ($LASTEXITCODE -ne 0) { throw "Parser build failed (exit $LASTEXITCODE). Nothing was copied." }

    Write-Host 'Building release manager...'
    & cargo build --release --locked --manifest-path (Join-Path $managerRoot 'Cargo.toml') --target-dir (Join-Path $managerRoot 'target') -p guitarpro-file-manager
    if ($LASTEXITCODE -ne 0) { throw "Manager build failed (exit $LASTEXITCODE). Nothing was copied." }

    $managerExe = Join-Path $managerRoot 'target\release\guitarpro-file-manager.exe'
    $parserExe = Join-Path $parserRoot 'target\release\score_tool.exe'
    foreach ($exe in @($managerExe, $parserExe)) {
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
            throw "Release executable not found: $exe. Nothing was copied. Check CARGO_BUILD_TARGET or Cargo target configuration."
        }
    }

    New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
    Copy-Item -LiteralPath $managerExe -Destination $InstallDirectory -Force
    Copy-Item -LiteralPath $parserExe -Destination $InstallDirectory -Force
    Write-Host "Installed both releases to $InstallDirectory"
    Write-Host 'Launch guitarpro-file-manager.exe from that folder and pin its taskbar icon.'
    Write-Host 'In Settings, select the score_tool.exe in that folder if an older parser path is saved.'
}
catch {
    Write-Error "Release installation failed: $($_.Exception.Message)" -ErrorAction Continue
    exit 1
}
