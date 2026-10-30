[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'performance-failure-diagnostic.ps1')
function Assert($Condition, [string] $Message) { if (-not $Condition) { throw $Message } }
foreach ($entry in @(
    @{ path = 'tmp\load\phase8-run-150x1000.ps1'; function = 'Require-Status' },
    @{ path = 'tmp\load\phase8-run-150x1000.ps1'; function = 'Read-ObservedScan' },
    @{ path = 'tmp\load\phase8-scheduled-run-150.ps1'; function = 'Save-State' }
)) {
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root $entry.path), [ref]$null, [ref]$parseErrors)
    Assert ($parseErrors.Count -eq 0) 'Script parse failed'
    $name = $entry.function
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    Assert ($null -ne $definition) 'Missing diagnostic function'
    Invoke-Expression $definition.Extent.Text
}
$primaryFailure = $null; $recoveryFailure = $null
$RunLabel = 'offline-test'; $WorkerConcurrency = 64; $UserCount = 500
$CrawlerVariant = 'Original'; $SkipOperationalGuards = $false; $ExistingSeedDirectory = ''
$statePath = Join-Path ([IO.Path]::GetTempPath()) ("weblens-failure-" + [Guid]::NewGuid().ToString('N') + '.json')
try {
    try {
        Require-Status @{ Status = 500; Body = @{ code = 'INTERNAL_ERROR'; detail = 'secret-body'; correlationId = 'be88952c-70a0-4335-b6c2-22890fe44d62' } } @(200) 'secret-action'
        throw 'Expected HTTP failure'
    } catch { $primaryFailure = New-PerformanceFailureDiagnostic $_ 'crawl-observation' }
    Assert ($primaryFailure.httpStatus -eq 500 -and $primaryFailure.errorCode -eq 'INTERNAL_ERROR') 'HTTP diagnostic lost'
    Assert ($primaryFailure.correlationId -eq 'be88952c-70a0-4335-b6c2-22890fe44d62') 'Correlation lost'
    Save-State 'FAILED'
    try { throw [TimeoutException]::new('secret-recovery-message') }
    catch { $recoveryFailure = New-PerformanceFailureDiagnostic $_ 'recovery' }
    Save-State 'RECOVERY_UNVERIFIED'
    $raw = [IO.File]::ReadAllText($statePath)
    $state = $raw | ConvertFrom-Json
    Assert ($state.primaryFailure.httpStatus -eq 500 -and $state.primaryFailure.stage -eq 'crawl-observation') 'Recovery overwrote primary error'
    Assert ($state.recoveryFailure.exceptionTypes -contains 'System.TimeoutException') 'Recovery error missing'
    Assert ($raw -notmatch 'secret-') 'Sensitive message/body leaked'
    $script:observations = [Collections.Generic.Queue[object]]::new()
    $script:observations.Enqueue(@{ Status = 500; Body = @{ code = 'INTERNAL_ERROR' } })
    $script:observations.Enqueue(@{ Status = 200; Body = @{ status = 'COMPLETED' } })
    $script:requests = 0
    function Invoke-WebLens([string] $Method, [string] $Path, [string] $Token) {
        Assert ($Method -eq 'GET') 'Polling replayed a write'
        $script:requests++
        return $script:observations.Dequeue()
    }
    $pollTokens = @{ '0' = 'offline-token' }
    $pollFailureCounts = @{}
    $pollFailureWriter = [IO.StringWriter]::new()
    Assert ($null -eq (Read-ObservedScan 'offline-scan' 0)) 'HTTP failure became a success'
    Assert ($requests -eq 1 -and $pollFailureCounts.HTTP_500 -eq 1) 'Immediate retry or missing failure'
    Assert ((Read-ObservedScan 'offline-scan' 0).status -eq 'COMPLETED') 'Next scheduled observation failed'
    Assert ($requests -eq 2 -and $pollFailureCounts.HTTP_500 -eq 1) 'Failure was removed after later success'
    function Invoke-WebLens { throw [InvalidOperationException]::new('offline-programming-failure') }
    $fatalPreserved = $false
    try { Read-ObservedScan 'offline-scan' 0 } catch { $fatalPreserved = $true }
    Assert $fatalPreserved 'Orchestration failure was treated as an HTTP observation'
    $pollFailureWriter.Dispose()
    Write-Output 'PASS: original HTTP/type/stage/correlation retained across recovery; secret messages excluded; no network calls.'
} finally {
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
}
