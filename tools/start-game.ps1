param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
try {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
    if (-not $nodePath) {
        $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $bundledNode) { $nodePath = $bundledNode }
    }
    if (-not $nodePath) { throw 'Node.js bulunamadi. Node.js LTS kurup yeniden deneyin: https://nodejs.org/' }
    $serverArgs = @((Join-Path $PSScriptRoot 'serve.mjs'))
    if (-not $NoBrowser) { $serverArgs += '--open' }
    & $nodePath @serverArgs
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
