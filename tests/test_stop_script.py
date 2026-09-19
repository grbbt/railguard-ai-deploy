"""Exercise launcher exit races with fake Process objects; never touch real services."""

import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell.exe")
pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or not POWERSHELL, reason="Windows launcher regression"
)

HARNESS = r"""
param([string]$Scenario, [string]$Root)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$global:TestRoot = $Root
$global:ManifestRemoved = $false
$global:Processes = @{}
$global:Snapshot = @()
$started = [datetime]::Parse('2026-09-18T00:00:00Z').ToUniversalTime()
# Windows PowerShell adds Path as type data; remove that extension only in
# this isolated test process so the fake can supply the saved executable.
Remove-TypeData -TypeName System.Diagnostics.Process -ErrorAction SilentlyContinue

function New-FakeProcess {
    param([int]$ProcessId, [datetime]$Started, [bool]$Exited = $false)
    $fake = New-Object System.Diagnostics.Process
    $fake | Add-Member NoteProperty Id $ProcessId -Force
    $fake | Add-Member NoteProperty Path (Join-Path $Root '.venv\Scripts\python.exe') -Force
    $fake | Add-Member NoteProperty Started $Started
    $fake | Add-Member NoteProperty Exited $Exited
    $fake | Add-Member NoteProperty MissingStart $false
    $fake | Add-Member NoteProperty UnreadableExit $false
    $fake | Add-Member NoteProperty StartReads 0
    $fake | Add-Member NoteProperty Killed $false
    $fake | Add-Member ScriptProperty StartTime {
        $this.StartReads++
        if (-not $this.MissingStart) { return $this.Started }
    } -Force
    $fake | Add-Member ScriptProperty HasExited {
        if ($this.UnreadableExit) { throw 'Process access denied' }
        return $this.Exited
    } -Force
    $fake | Add-Member ScriptMethod Refresh {} -Force
    $fake | Add-Member ScriptMethod Kill { $this.Killed = $true; $this.Exited = $true } -Force
    $fake | Add-Member ScriptMethod WaitForExit { param($Timeout) return $this.Exited } -Force
    return $fake
}

$rootProcess = New-FakeProcess 910001 $started
$childProcess = New-FakeProcess 910002 $started.AddSeconds(1)
$global:Processes[910001] = $rootProcess
$global:Processes[910002] = $childProcess
$childRecord = [pscustomobject]@{
    ProcessId = 910002; ParentProcessId = 910001; CreationDate = $started.AddSeconds(1)
}
$global:Snapshot = @($childRecord)
$global:Manifest = @{
    workspace = $Root
    processes = @(@{
        pid = 910001; started_at = $started.ToString('o'); role = 'backend'
        executable = Join-Path $Root '.venv\Scripts\python.exe'
    })
} | ConvertTo-Json -Depth 5

switch ($Scenario) {
    'root-exited' { $rootProcess.MissingStart = $true; $rootProcess.Exited = $true }
    'child-exited' { $childProcess.MissingStart = $true; $childProcess.Exited = $true }
    'child-unreadable' { $childProcess.MissingStart = $true }
    'child-access-denied' { $childProcess.MissingStart = $true; $childProcess.UnreadableExit = $true }
    'snapshot-child-exited' { $childRecord.CreationDate = $null; $childProcess.Exited = $true }
    'snapshot-child-unreadable' { $childRecord.CreationDate = $null }
    'root-pid-reused' { $rootProcess.Started = $started.AddMinutes(1) }
    'child-pid-reused' { $childProcess.Started = $started.AddMinutes(1) }
    'root-executable-mismatch' { $rootProcess.Path = 'C:\unrelated.exe' }
}

# All process access and manifest mutation are intercepted. Unknown targets fail.
function Get-Process {
    param([int]$Id, [string]$ErrorAction)
    if (-not $global:Processes.ContainsKey($Id)) { throw 'Unexpected process lookup' }
    return $global:Processes[$Id]
}
function Get-CimInstance {
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -ne 'Win32_Process') { throw 'Unexpected CIM query' }
    if ($Filter) {
        if ($Filter -ne 'ProcessId = 910001') { throw 'Unexpected process query' }
        return [pscustomobject]@{ CommandLine = 'python -m uvicorn backend.api:app' }
    }
    return $global:Snapshot
}
function Test-Path {
    param([string]$LiteralPath, [string]$PathType)
    if ($LiteralPath -eq (Join-Path $global:TestRoot '.logs\processes.json')) { return $true }
    return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType
}
function Get-Content {
    param([string]$LiteralPath, [switch]$Raw)
    if ($LiteralPath -ne (Join-Path $global:TestRoot '.logs\processes.json')) { throw 'Unexpected read' }
    return $global:Manifest
}
function Remove-Item {
    param([string]$LiteralPath)
    if ($LiteralPath -ne (Join-Path $global:TestRoot '.logs\processes.json')) { throw 'Unexpected deletion' }
    $global:ManifestRemoved = $true
}

$failure = $null
try { & (Join-Path $Root 'scripts\stop.ps1') -Quiet } catch { $failure = $_.Exception.Message }
[pscustomobject]@{
    failure = $failure; removed = $global:ManifestRemoved
    root_killed = $rootProcess.Killed; child_killed = $childProcess.Killed
    root_start_reads = $rootProcess.StartReads
} | ConvertTo-Json -Compress
"""


@pytest.mark.parametrize(
    "scenario,failed,root_killed,child_killed",
    [
        ("normal", False, True, True),
        ("root-exited", False, False, False),
        ("child-exited", False, True, False),
        ("child-unreadable", True, False, False),
        ("child-access-denied", True, False, False),
        ("snapshot-child-exited", False, True, False),
        ("snapshot-child-unreadable", True, False, False),
        ("root-pid-reused", True, False, False),
        ("child-pid-reused", False, True, False),
        ("root-executable-mismatch", True, False, False),
    ],
)
def test_stop_script_exit_races(
    tmp_path, scenario, failed, root_killed, child_killed
):
    harness = tmp_path / "stop-harness.ps1"
    harness.write_text(HARNESS, encoding="utf-8")
    result = subprocess.run(
        [
            POWERSHELL,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(harness),
            scenario,
            str(ROOT),
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    output = json.loads(next(line for line in result.stdout.splitlines() if line.startswith("{")))
    assert bool(output["failure"]) is failed, output
    assert output["removed"] is not failed, output
    assert output["root_killed"] is root_killed, output
    assert output["child_killed"] is child_killed, output
    assert output["root_start_reads"] == 1, output
