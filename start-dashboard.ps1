$ErrorActionPreference = "Stop"

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) {
    $nodeCommand.Source
} else {
    Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}

if (-not (Test-Path $nodePath)) {
    Write-Host "Node.js 20+ is required. Download it from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path (Join-Path $PSScriptRoot ".env"))) {
    Write-Host "No .env file found. The dashboard will start in demo mode." -ForegroundColor Yellow
    Write-Host "Copy .env.example to .env and add your Roboflow API key for live inference."
}

Push-Location $PSScriptRoot
try {
    & $nodePath "server.mjs"
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
