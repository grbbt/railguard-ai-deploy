[CmdletBinding()]
param([string]$Python, [switch]$RefreshDependencies)

. (Join-Path $PSScriptRoot '_common.ps1')

$venvDirectory = Get-RailGuardPath '.venv'
$venvPython = Get-RailGuardPath '.venv\Scripts\python.exe'
$frontendDirectory = Get-RailGuardPath 'frontend'
$nodeExecutable = Get-RailGuardExecutable 'node.exe'
$npmExecutable = Get-RailGuardExecutable 'npm.cmd'
Invoke-RailGuardCommand $nodeExecutable @('-e', 'const v=process.versions.node.split(''.'').map(Number); if(v[0]<20 || (v[0]===20 && v[1]<9)){console.error(''Node.js 20.9 or newer is required.'');process.exit(1)} console.log(''Node.js ''+process.versions.node)') 'Checking Node.js'

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    $pythonArguments = @()
    if ($Python) {
        $pythonExecutable = Get-RailGuardExecutable $Python
    } elseif (Get-Command -Name 'py.exe' -CommandType Application -ErrorAction SilentlyContinue) {
        $pythonExecutable = Get-RailGuardExecutable 'py.exe'
        $pythonArguments = @('-3')
    } else {
        $pythonExecutable = Get-RailGuardExecutable 'python.exe'
    }
    Invoke-RailGuardCommand $pythonExecutable ($pythonArguments + @('-c', 'import sys; print(sys.version); sys.exit(0 if sys.version_info >= (3,12) else ''Python 3.12 or newer is required for the tested dependency lock.'')')) 'Checking Python'
    Invoke-RailGuardCommand $pythonExecutable ($pythonArguments + @('-m', 'venv', $venvDirectory)) 'Creating the project virtual environment'
}

Invoke-RailGuardCommand $venvPython @('-c', 'import sys; print(sys.version); sys.exit(0 if sys.version_info >= (3,12) else ''Recreate this virtual environment using Python 3.12 or newer.'')') 'Checking the project Python environment'
$requirements = Get-RailGuardPath 'requirements-lock.txt'
if ($RefreshDependencies -or -not (Test-Path -LiteralPath $requirements -PathType Leaf)) {
    $requirements = Get-RailGuardPath 'requirements.txt'
}
Invoke-RailGuardCommand $venvPython @('-m', 'pip', 'install', '-r', $requirements) 'Installing Python dependencies'

Push-Location -LiteralPath $frontendDirectory
try {
    Invoke-RailGuardCommand $npmExecutable @('ci') 'Installing the locked frontend dependencies'
} finally {
    Pop-Location
}

Write-Host 'Setup complete. Start RailGuard with .\scripts\start.ps1'
