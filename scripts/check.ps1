[CmdletBinding()]
param([switch]$SkipBuild)

. (Join-Path $PSScriptRoot '_common.ps1')

$projectPython = Get-RailGuardPath '.venv\Scripts\python.exe'
$frontendDirectory = Get-RailGuardPath 'frontend'
$npmExecutable = Get-RailGuardExecutable 'npm.cmd'
$nodeExecutable = Get-RailGuardExecutable 'node.exe'
$nextCli = Get-RailGuardPath 'frontend\node_modules\next\dist\bin\next'
if (-not (Test-Path -LiteralPath $projectPython -PathType Leaf)) {
    throw 'The virtual environment is missing. Run .\scripts\setup.ps1 first.'
}
if (-not $SkipBuild -and (Test-RailGuardPort 3000)) {
    throw 'Stop the development frontend before a production build so both processes do not write frontend/.next. No existing process was stopped. Use -SkipBuild for tests, typecheck and lint while developing.'
}
Push-Location -LiteralPath $script:RailGuardRoot
try {
    # Isolate test files per run. Shared Windows temp/cache directories can have
    # different ACLs when checks alternate between a sandbox and the desktop user.
    $testRunDirectory = [IO.Path]::GetFullPath((Join-Path $script:RailGuardRoot ('.cache\verification\' + [guid]::NewGuid().ToString('N'))))
    $testRunRoot = [IO.Path]::GetFullPath((Join-Path $script:RailGuardRoot '.cache\verification')) + [IO.Path]::DirectorySeparatorChar
    if (-not $testRunDirectory.StartsWith($testRunRoot, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $testRunDirectory)) {
        throw 'The isolated test directory must be new and inside the project verification cache.'
    }
    New-Item -ItemType Directory -Path $testRunDirectory -Force | Out-Null
    $pytestTempDirectory = Join-Path $testRunDirectory 'temporary'
    Invoke-RailGuardCommand $projectPython @('-m', 'pytest', 'tests', '-q', '-p', 'no:cacheprovider', '--basetemp', $pytestTempDirectory) 'Running Python pipeline, API and dataset tests'
} finally {
    Pop-Location
}
Push-Location -LiteralPath $frontendDirectory
try {
    Invoke-RailGuardCommand $nodeExecutable @('--test', 'src/lib/ps3-upload-proxy.test.mjs', 'src/components/ps3/request-error.test.mjs') 'Checking streamed uploads and hosted error messages'
    Invoke-RailGuardCommand $nodeExecutable @('--test', 'src/components/ps3/job-state.test.mjs', 'src/components/ps3/telemetry-chart.test.mjs', 'src/components/ps3/validation-input.test.mjs', 'src/components/ps3/prediction-comparison.test.mjs', 'src/components/ps3/result-overview.test.mjs', 'src/components/ps3/investigation-state.test.mjs', 'src/components/ps3/investigation-scroll.test.mjs', 'src/components/workspace/workspace-state.test.mjs', 'src/components/workspace/window-geometry.test.mjs', 'src/components/workspace/result-summary.test.mjs', 'src/components/workspace/recording-mapping.test.mjs', 'src/components/workspace/export-selection.test.mjs') 'Checking investigation sessions, prediction comparisons, export selections, batch uploads, workspace history and recording component mappings'
    if (-not $SkipBuild) {
        Invoke-RailGuardCommand $nodeExecutable @($nextCli, 'typegen') 'Generating Next.js route types'
    }
    Invoke-RailGuardCommand $npmExecutable @('run', 'typecheck') 'Checking TypeScript'
    Invoke-RailGuardCommand $npmExecutable @('run', 'lint') 'Running frontend lint'
    if (-not $SkipBuild) {
        Invoke-RailGuardCommand $npmExecutable @('run', 'build') 'Building the production frontend'
    }
} finally {
    Pop-Location
}
Write-Host 'All requested checks passed.'
