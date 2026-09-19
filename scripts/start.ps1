[CmdletBinding()]
param([switch]$NoWait, [switch]$ValidateOnly, [switch]$Production)

. (Join-Path $PSScriptRoot '_common.ps1')

$backendPython = Get-RailGuardPath '.venv\Scripts\python.exe'
$frontendDirectory = Get-RailGuardPath 'frontend'
$nextCli = Get-RailGuardPath 'frontend\node_modules\next\dist\bin\next'
$nodeExecutable = Get-RailGuardExecutable 'node.exe'
$nextCommand = 'dev'
if ($Production) {
    $nextCommand = 'start'
    if (-not (Test-Path -LiteralPath (Get-RailGuardPath 'frontend\.next\BUILD_ID') -PathType Leaf)) {
        throw 'A production frontend build is required. Stop the development frontend and run .\scripts\check.ps1 (or npm run build in frontend), then run .\scripts\start.ps1 -Production. No processes were started.'
    }
}
foreach ($required in @($backendPython, $nextCli)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Dependency is missing: $required. Run .\scripts\setup.ps1 first."
    }
}
if ($ValidateOnly) {
    Write-Host "Validated workspace: $script:RailGuardRoot"
    Write-Host "Backend: $backendPython -m uvicorn backend.api:app --host 127.0.0.1 --port 8000"
    Write-Host "Frontend: $nodeExecutable `"$nextCli`" $nextCommand --hostname 127.0.0.1 --port 3000"
    Write-Host 'Validation only; no processes were started.'
    return
}
foreach ($servicePort in @(8000, 3000)) {
    if (Test-RailGuardPort $servicePort) {
        throw "Port $servicePort is already in use. Stop the existing service or run .\scripts\stop.ps1 if RailGuard started it. No existing process was stopped."
    }
}

$logDirectory = Get-RailGuardPath '.logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$startedProcesses = @()

function Add-ServiceRecord {
    param([string]$Role, [System.Diagnostics.Process]$Process, [string]$Executable)
    return @{ role = $Role; pid = $Process.Id; started_at = $Process.StartTime.ToUniversalTime().ToString('o'); executable = $Executable }
}

function Wait-ServiceEndpoint {
    param([string]$Uri, [System.Diagnostics.Process]$Process, [string]$Name)
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "$Name exited during startup. Read its log in $logDirectory." }
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) { return }
        } catch {
            Start-Sleep -Milliseconds 700
        }
    }
    throw "$Name did not become ready within 60 seconds. Read its log in $logDirectory."
}

try {
    $backendProcess = Start-Process -FilePath $backendPython -ArgumentList @('-m', 'uvicorn', 'backend.api:app', '--host', '127.0.0.1', '--port', '8000') -WorkingDirectory $script:RailGuardRoot -WindowStyle Hidden -RedirectStandardOutput (Get-RailGuardPath '.logs\backend.out.log') -RedirectStandardError (Get-RailGuardPath '.logs\backend.err.log') -PassThru
    $startedProcesses += Add-ServiceRecord 'backend' $backendProcess $backendPython
    Save-RailGuardManifest $startedProcesses

    # Start-Process joins its arguments; explicitly quote the CLI path for workspaces with spaces.
    $frontendProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @(('"' + $nextCli + '"'), $nextCommand, '--hostname', '127.0.0.1', '--port', '3000') -WorkingDirectory $frontendDirectory -WindowStyle Hidden -RedirectStandardOutput (Get-RailGuardPath '.logs\frontend.out.log') -RedirectStandardError (Get-RailGuardPath '.logs\frontend.err.log') -PassThru
    $startedProcesses += Add-ServiceRecord 'frontend' $frontendProcess $nodeExecutable
    Save-RailGuardManifest $startedProcesses

    if (-not $NoWait) {
        Write-Host 'Waiting for the local API and frontend to become ready...'
        Wait-ServiceEndpoint 'http://127.0.0.1:8000/api/health' $backendProcess 'Backend'
        Wait-ServiceEndpoint 'http://127.0.0.1:3000' $frontendProcess 'Frontend'
    }
    Write-Host 'RailGuard: http://127.0.0.1:3000'
    if ($Production) { Write-Host 'Frontend mode: production build (local presentation)' }
    Write-Host 'API documentation: http://127.0.0.1:8000/docs'
    Write-Host "Logs: $logDirectory"
    Write-Host 'Stop these services with .\scripts\stop.ps1'
} catch {
    $startupError = $_
    if ($startedProcesses.Count -gt 0) {
        & (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
    }
    throw $startupError
}
