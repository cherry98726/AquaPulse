$ErrorActionPreference = "Stop"

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

function Wait-ForLocalPort {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not (Test-LocalPort -Port $Port)) {
        if ((Get-Date) -gt $deadline) {
            throw "Port $Port is not reachable. Please check whether the local service started correctly."
        }

        Start-Sleep -Seconds 1
    }
}

function Get-DotEnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $envPath = Join-Path $PSScriptRoot ".env"
    if (-not (Test-Path $envPath)) {
        return $null
    }

    foreach ($line in Get-Content -Path $envPath -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }

        $separator = $trimmed.IndexOf("=")
        if ($separator -lt 1) {
            continue
        }

        $key = $trimmed.Substring(0, $separator).Trim()
        if ($key -ne $Name) {
            continue
        }

        $value = $trimmed.Substring($separator + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        return $value
    }

    return $null
}

function Test-AquaPulseDashboard {
    param([Parameter(Mandatory = $true)][string]$BaseUrl)

    try {
        $config = Invoke-RestMethod -Uri "$BaseUrl/api/config" -UseBasicParsing -TimeoutSec 2
        return [bool]($config.dashboards -or $config.defaultModelId)
    } catch {
        return $false
    }
}

function Start-DashboardBrowser {
    param([Parameter(Mandatory = $true)][string]$BaseUrl)

    Start-Process "$BaseUrl/dashboards/lego"
    Start-Sleep -Milliseconds 500
    Start-Process "$BaseUrl/dashboards/people"
}

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

$versionText = & $nodePath "--version"
if ($versionText -match "^v(?<major>\d+)") {
    $nodeMajorVersion = [int]$Matches.major
} else {
    Write-Host "Could not read Node.js version from $nodePath" -ForegroundColor Yellow
    exit 1
}

if ($nodeMajorVersion -lt 20) {
    Write-Host "Node.js 20+ is required, but this computer has $versionText." -ForegroundColor Yellow
    Write-Host "Download the current LTS version from https://nodejs.org/"
    exit 1
}

$dashboardPortValue = Get-DotEnvValue -Name "PORT"
$dashboardPort = 3000
if ($dashboardPortValue) {
    $parsedPort = 0
    if ([int]::TryParse($dashboardPortValue, [ref]$parsedPort) -and $parsedPort -gt 0) {
        $dashboardPort = $parsedPort
    } else {
        Write-Host "PORT in .env is invalid: $dashboardPortValue" -ForegroundColor Yellow
        exit 1
    }
}
$dashboardBaseUrl = "http://127.0.0.1:$dashboardPort"

Push-Location $PSScriptRoot
try {
    if (-not (Test-Path (Join-Path $PSScriptRoot ".env"))) {
        Write-Host "No .env file found. Copy .env.example to .env before running live detection." -ForegroundColor Yellow
    }

    if (Test-LocalPort -Port $dashboardPort) {
        if (Test-AquaPulseDashboard -BaseUrl $dashboardBaseUrl) {
            Write-Host "AquaPulse Dashboard is already running on $dashboardBaseUrl"
            Start-DashboardBrowser -BaseUrl $dashboardBaseUrl
            exit 0
        }

        Write-Host "Port $dashboardPort is already in use, but it does not look like AquaPulse Dashboard." -ForegroundColor Yellow
        Write-Host "Close the app using port $dashboardPort, or change PORT in .env."
        exit 1
    }

    if (-not (Test-LocalPort -Port 9001)) {
        Write-Host "Starting Roboflow Inference Server on http://127.0.0.1:9001 ..."
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-inference-server.ps1")
    }

    Wait-ForLocalPort -Port 9001 -TimeoutSeconds 60

    Write-Host ""
    Write-Host "Roboflow Inference Server: http://127.0.0.1:9001"
    Write-Host "AquaPulse Dashboard will start on: $dashboardBaseUrl"
    Write-Host ""
    Write-Host "Open one of these links after the dashboard log appears:"
    Write-Host "  $dashboardBaseUrl/dashboards/lego"
    Write-Host "  $dashboardBaseUrl/dashboards/people"
    Write-Host ""

    Start-Job -ScriptBlock {
        param($Port, $BaseUrl)

        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            $client = New-Object System.Net.Sockets.TcpClient
            try {
                $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
                if ($async.AsyncWaitHandle.WaitOne(500, $false)) {
                    $client.EndConnect($async)
                    Start-Process "$BaseUrl/dashboards/lego"
                    Start-Sleep -Milliseconds 500
                    Start-Process "$BaseUrl/dashboards/people"
                    return
                }
            } catch {
            } finally {
                $client.Close()
            }

            Start-Sleep -Seconds 1
        }
    } -ArgumentList $dashboardPort, $dashboardBaseUrl | Out-Null

    & $nodePath "server.mjs"
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
