Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$env:NEXT_TELEMETRY_DISABLED = '1'
$script:RailGuardRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath.TrimEnd('\', '/')

function Get-RailGuardPath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)
    $target = [System.IO.Path]::GetFullPath((Join-Path $script:RailGuardRoot $RelativePath))
    $prefix = $script:RailGuardRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Target is outside the RailGuard workspace: $target"
    }
    return $target
}

foreach ($marker in @('README.md', 'backend\api.py', 'frontend\package.json')) {
    if (-not (Test-Path -LiteralPath (Get-RailGuardPath $marker) -PathType Leaf)) {
        throw "Run these scripts from the RailGuard repository; required file is missing: $marker"
    }
}

function Get-RailGuardExecutable {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw "Required executable '$Name' was not found. Run .\scripts\setup.ps1 after installing the prerequisites." }
    return $command.Source
}

function Invoke-RailGuardCommand {
    param([string]$Executable, [string[]]$Arguments, [string]$Label)
    Write-Host $Label
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE)." }
}

function Test-RailGuardPort {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $attempt = $client.ConnectAsync('127.0.0.1', $Port)
        if ($attempt.Wait(500)) { return $client.Connected }
        return $false
    } catch { return $false } finally { $client.Dispose() }
}

function Save-RailGuardManifest {
    param([object[]]$Processes)
    $manifest = @{ version = 1; workspace = $script:RailGuardRoot; processes = @($Processes) }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Get-RailGuardPath '.logs\processes.json') -Encoding UTF8
}

function ConvertTo-RailGuardUtcInstant {
    param([Parameter(Mandatory = $true)][object]$Value)
    # ConvertFrom-Json preserves ISO text in Windows PowerShell, but newer
    # PowerShell versions may materialize DateTime/DateTimeOffset values.
    if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
    if ($Value -is [DateTime]) {
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) {
            # Launcher manifests always record a UTC instant.
            return [DateTime]::SpecifyKind($Value, [DateTimeKind]::Utc)
        }
        return $Value.ToUniversalTime()
    }
    return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime
}
