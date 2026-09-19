[CmdletBinding()]
param([switch]$Quiet)

. (Join-Path $PSScriptRoot '_common.ps1')

$manifestPath = Get-RailGuardPath '.logs\processes.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    if (-not $Quiet) { Write-Host 'No launch record exists. No processes were stopped.' }
    return
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.workspace -ne $script:RailGuardRoot) {
    throw 'The process record belongs to a different workspace. No processes were stopped.'
}
$stopped = 0
$stopFailures = @()

function Test-RailGuardProcessExited {
    param([System.Diagnostics.Process]$Process)
    try {
        $Process.Refresh()
        return $Process.HasExited
    } catch {
        # An inaccessible process must not be treated as an exited process.
        return $false
    }
}

function Get-RailGuardLiveProcessStart {
    param([System.Diagnostics.Process]$Process)
    try {
        $start = $Process.StartTime
        if ($null -eq $start) { throw 'The process start time is unavailable.' }
        return $start.ToUniversalTime()
    } catch {
        # The process can exit after Get-Process, before StartTime is read.
        if (Test-RailGuardProcessExited $Process) { return $null }
        throw
    }
}

function Stop-VerifiedRailGuardProcess {
    param([System.Diagnostics.Process]$Process, [string]$Description)
    try {
        $Process.Refresh()
        if ($Process.HasExited) { return }
        $Process.Kill()
        if (-not $Process.WaitForExit(3000)) {
            throw "$Description (PID $($Process.Id)) is still running after the termination request."
        }
    } catch {
        $terminationError = $_
        $exited = $false
        try {
            $Process.Refresh()
            $exited = $Process.HasExited
        } catch {
            # Failure to inspect a process is not evidence that it exited.
        }
        if (-not $exited) {
            throw "Could not stop $Description (PID $($Process.Id)): $($terminationError.Exception.Message)"
        }
        # The process may have exited between the identity check and Kill().
    }
}

foreach ($record in $manifest.processes) {
    $service = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if (-not $service) { continue }
    try {
        $recordedStart = ConvertTo-RailGuardUtcInstant $record.started_at
        $actualStart = Get-RailGuardLiveProcessStart $service
        if ($null -eq $actualStart) { continue }
        $sameStart = [Math]::Abs(($actualStart - $recordedStart).TotalMilliseconds) -lt 1
        $actualExecutable = $service.Path
        $sameExecutable = [string]::Equals($actualExecutable, [string]$record.executable, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        if (Test-RailGuardProcessExited $service) { continue }
        $stopFailures += "Could not validate the identity of live recorded PID $($record.pid): $($_.Exception.Message)"
        continue
    }
    if (-not $sameStart -or -not $sameExecutable) {
        if (Test-RailGuardProcessExited $service) { continue }
        Write-Warning "PID $($record.pid) no longer matches the recorded RailGuard process; skipped."
        $stopFailures += "Live recorded PID $($record.pid) did not match its saved identity and was left running."
        continue
    }
    $command = Get-CimInstance Win32_Process -Filter "ProcessId = $($service.Id)"
    if (-not $command -or -not $command.CommandLine) {
        if (-not (Test-RailGuardProcessExited $service)) {
            $stopFailures += "Could not inspect the command line of recorded PID $($record.pid); it was left running."
        }
        continue
    }
    $verified = $false
    if ($record.role -eq 'backend') {
        $verified = $actualExecutable -eq (Get-RailGuardPath '.venv\Scripts\python.exe') -and $command.CommandLine -like '*backend.api:app*'
    } elseif ($record.role -eq 'frontend') {
        $verified = $command.CommandLine.Contains((Get-RailGuardPath 'frontend\node_modules\next\dist\bin\next'))
    }
    if (-not $verified) {
        Write-Warning "PID $($record.pid) could not be identified as this workspace's service; skipped."
        $stopFailures += "Recorded PID $($record.pid) remains unverified and was left running."
        continue
    }
    try {
        # Next may create a server child. Only descendants of the verified launch PID are eligible.
        $snapshot = @(Get-CimInstance Win32_Process)
        $descendants = @()
        # Reuse the validated timestamp; the root may already be exiting now.
        $parents = @{ ([int]$service.Id) = $actualStart }
        while ($parents.Count -gt 0) {
            $children = @()
            foreach ($candidate in $snapshot) {
                $parentId = [int]$candidate.ParentProcessId
                if (-not $parents.ContainsKey($parentId)) { continue }
                if ($null -eq $candidate.CreationDate) {
                    $candidateProcess = Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction SilentlyContinue
                    if (-not $candidateProcess -or (Test-RailGuardProcessExited $candidateProcess)) { continue }
                    throw "Could not validate the creation time of child PID $($candidate.ProcessId); it was left running."
                }
                if ($candidate.CreationDate.ToUniversalTime() -ge $parents[$parentId].AddMilliseconds(-1)) {
                    $children += $candidate
                }
            }
            $descendants += $children
            $parents = @{}
            foreach ($child in $children) {
                $parents[[int]$child.ProcessId] = $child.CreationDate.ToUniversalTime()
            }
        }
        [array]::Reverse($descendants)
        foreach ($child in $descendants) {
            $process = Get-Process -Id ([int]$child.ProcessId) -ErrorAction SilentlyContinue
            if (-not $process) { continue }
            $childStart = Get-RailGuardLiveProcessStart $process
            if ($null -ne $childStart -and [Math]::Abs(($childStart - $child.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 1) {
                Stop-VerifiedRailGuardProcess $process "RailGuard $($record.role) child"
            }
        }
        Stop-VerifiedRailGuardProcess $service "RailGuard $($record.role) service"
        $stopped++
    } catch {
        # Retain the root launch identity if child termination failed, so a retry
        # can identify the same tree instead of abandoning an untracked service.
        $stopFailures += $_.Exception.Message
    }
}
if ($stopFailures.Count -gt 0) {
    throw ('Some RailGuard processes could not be stopped. The launch record was retained at ' + $manifestPath + '. ' + ($stopFailures -join ' '))
}
Remove-Item -LiteralPath $manifestPath
if (-not $Quiet) { Write-Host "Stopped $stopped recorded RailGuard services. Unrelated listeners were left running." }
