$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $projectRoot "dist"
$releaseExe = Join-Path $projectRoot "target\release\axiver-client.exe"
$portableExe = Join-Path $distRoot "AXIVER-Client.exe"

Push-Location $projectRoot
try {
    cargo build --release --locked
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
Copy-Item -LiteralPath $releaseExe -Destination $portableExe -Force

Write-Host "Portable build: $portableExe"
Write-Host "Settings database will be created beside the executable as axiver-client.db."
