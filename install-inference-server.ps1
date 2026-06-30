param(
    [string]$Version = "1.3.2",
    [switch]$ForceReinstall
)

$ErrorActionPreference = "Stop"

$version = $Version.Trim().TrimStart("v")
$installerName = "inference-$version-cpu-installer.exe"
$downloadUrl = "https://github.com/roboflow/inference/releases/download/v$version/$installerName"
$downloadDir = Join-Path $env:TEMP "aquapulse-roboflow-inference"
$installerPath = Join-Path $downloadDir $installerName
$installPath = Join-Path $env:LOCALAPPDATA "RoboflowInference\inference.exe"
$minimumInstallerBytes = 100MB

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # Older PowerShell versions may not expose this setting. Invoke-WebRequest will use its default.
}

function Test-LocalPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(500, $false)) {
            return $false
        }

        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-InferenceServer {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:9001/docs" -UseBasicParsing -TimeoutSec 3
        return $response.Content -like "*Roboflow Inference Server*"
    } catch {
        return $false
    }
}

function Stop-InferenceServer {
    $processes = Get-Process -Name "inference" -ErrorAction SilentlyContinue
    if (-not $processes) {
        return
    }

    Write-Host "Stopping existing Roboflow Inference Server..."
    $processes | Stop-Process -Force
    Start-Sleep -Seconds 2
}

function Show-InstallLogTail {
    param([Parameter(Mandatory = $true)][string]$LogPath)

    if (-not (Test-Path $LogPath)) {
        Write-Host "Installer did not create a log file at $LogPath" -ForegroundColor Yellow
        return
    }

    Write-Host ""
    Write-Host "Last installer log lines from ${LogPath}:" -ForegroundColor Yellow
    Get-Content -Path $LogPath -Tail 80
    Write-Host ""
}

function Download-Installer {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Write-Host "Downloading Roboflow Inference CPU installer (attempt $attempt of 3)..."
            Invoke-WebRequest -Uri $Url -OutFile $OutputPath -UseBasicParsing

            $file = Get-Item -LiteralPath $OutputPath
            if ($file.Length -lt $minimumInstallerBytes) {
                Remove-Item -LiteralPath $OutputPath -Force
                throw "Downloaded installer is too small ($($file.Length) bytes)."
            }

            try {
                Unblock-File -Path $OutputPath -ErrorAction SilentlyContinue
            } catch {
            }

            return
        } catch {
            if ($attempt -eq 3) {
                throw @"
Could not download the Roboflow Inference installer.

Manual fallback:
1. Open this URL in the browser:
   $Url
2. Save the file here:
   $OutputPath
3. Run this script again:
   powershell -ExecutionPolicy Bypass -File .\install-inference-server.ps1

Original error:
$($_.Exception.Message)
"@
            }

            Start-Sleep -Seconds 2
        }
    }
}

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

if ((Test-LocalPort -Port 9001) -and (Test-InferenceServer) -and -not $ForceReinstall) {
    Write-Host "Roboflow Inference Server is already running on http://127.0.0.1:9001"
    exit 0
}

if ((Test-LocalPort -Port 9001) -and -not (Test-InferenceServer)) {
    throw "Port 9001 is already in use, but it does not look like Roboflow Inference Server. Close the app using port 9001 and run this script again."
}

if ($ForceReinstall) {
    Stop-InferenceServer
}

if ((-not (Test-Path $installPath)) -or $ForceReinstall) {
    if (Test-Path $installerPath) {
        $existingInstaller = Get-Item -LiteralPath $installerPath
        if ($existingInstaller.Length -lt $minimumInstallerBytes) {
            Write-Host "Existing installer looks incomplete. Downloading a fresh copy..."
            Remove-Item -LiteralPath $installerPath -Force
        }
    }

    if (-not (Test-Path $installerPath)) {
        Download-Installer -Url $downloadUrl -OutputPath $installerPath
    }

    Write-Host "Installing Roboflow Inference..."
    $logPath = Join-Path $downloadDir "install.log"
    if (Test-Path $logPath) {
        Remove-Item -LiteralPath $logPath -Force
    }

    $process = Start-Process -FilePath $installerPath -ArgumentList @(
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/CURRENTUSER",
        "/LOG=$logPath"
    ) -Wait -PassThru

    if ($process.ExitCode -ne 0) {
        Show-InstallLogTail -LogPath $logPath
        throw @"
Roboflow Inference installer failed with exit code $($process.ExitCode).

Installer path:
$installerPath

Installer log:
$logPath

Try running this PowerShell window as Administrator, then run:
powershell -ExecutionPolicy Bypass -File .\install-inference-server.ps1 -ForceReinstall -Version 1.3.2
"@
    }

    if (-not (Test-Path $installPath)) {
        Show-InstallLogTail -LogPath $logPath
        throw "Roboflow Inference was installed, but inference.exe was not found at $installPath"
    }
}

Write-Host "Starting Roboflow Inference Server on http://127.0.0.1:9001 ..."
Start-Process -FilePath $installPath -WorkingDirectory (Split-Path $installPath) -WindowStyle Hidden
Start-Sleep -Seconds 5

if (-not (Test-InferenceServer)) {
    throw @"
Roboflow Inference was started, but http://127.0.0.1:9001/docs is not healthy yet.

If you saw a Pydantic error such as:
Field name 'schema' shadows an attribute in parent BaseModel

run this fallback command:
powershell -ExecutionPolicy Bypass -File .\install-inference-server.ps1 -ForceReinstall -Version 1.3.2
"@
}

Write-Host "Done. Roboflow Inference Server v$version is running on http://127.0.0.1:9001"
