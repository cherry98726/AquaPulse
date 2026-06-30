$ErrorActionPreference = "Stop"

$version = "1.3.3"
$installerName = "inference-$version-cpu-installer.exe"
$downloadUrl = "https://github.com/roboflow/inference/releases/download/v$version/$installerName"
$downloadDir = Join-Path $env:TEMP "aquapulse-roboflow-inference"
$installerPath = Join-Path $downloadDir $installerName
$installPath = Join-Path $env:LOCALAPPDATA "RoboflowInference\inference.exe"

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

$listener = Get-NetTCPConnection -LocalPort 9001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    Write-Host "Roboflow Inference Server is already running on http://127.0.0.1:9001"
    exit 0
}

if (-not (Test-Path $installPath)) {
    if (-not (Test-Path $installerPath)) {
        Write-Host "Downloading Roboflow Inference CPU installer..."
        Invoke-WebRequest -Uri $downloadUrl -OutFile $installerPath -UseBasicParsing
    }

    Write-Host "Installing Roboflow Inference..."
    $logPath = Join-Path $downloadDir "install.log"
    $process = Start-Process -FilePath $installerPath -ArgumentList @(
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/CURRENTUSER",
        "/LOG=$logPath"
    ) -Wait -PassThru

    if ($process.ExitCode -ne 0) {
        throw "Roboflow Inference installer failed with exit code $($process.ExitCode). See $logPath"
    }

    if (-not (Test-Path $installPath)) {
        throw "Roboflow Inference was installed, but inference.exe was not found at $installPath"
    }
}

Write-Host "Starting Roboflow Inference Server on http://127.0.0.1:9001 ..."
Start-Process -FilePath $installPath -WorkingDirectory (Split-Path $installPath) -WindowStyle Hidden
Write-Host "Done. Keep the Roboflow Inference Server running while using the GitHub Pages dashboard."
