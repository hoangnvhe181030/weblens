$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot 'recovery-index-preflight-windows.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Preflight syntax failure' }
$definition = $ast.Find({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Read-IndexPreflight'
}, $true)
Invoke-Expression $definition.Extent.Text
$scopeDefinition = $ast.Find({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Read-PreflightScope'
}, $true)
Invoke-Expression $scopeDefinition.Extent.Text
$values = @{ CRAWLER_POSTGRES_URL = 'postgres://probe:synthetic-secret@127.0.0.1:5433/weblens_crawler' }
$psqlTool = 'Invoke-FakePsql'
$script:fakeMode = 'ok'
$script:calls = 0
function Invoke-FakePsql {
    $script:calls++
    if ($env:PGOPTIONS -notmatch 'statement_timeout=2000.*lock_timeout=500.*default_transaction_read_only=on') {
        throw 'Missing bounded read-only configuration'
    }
    if ($script:fakeMode -eq 'ok') { $global:LASTEXITCODE = 0; '{"version":"17.11"}' }
    else { $global:LASTEXITCODE = 3; "ERROR: $script:fakeMode" }
}
$savedPassword = $env:PGPASSWORD; $savedOptions = $env:PGOPTIONS
try {
    $env:PGPASSWORD = 'original-test-secret'; $env:PGOPTIONS = 'original-options'
    $result = Read-IndexPreflight 'postgres://probe:synthetic-secret@127.0.0.1:5433/weblens_crawler' $null $null 'SELECT 1'
    if ($result.version -ne '17.11') { throw 'Successful result not parsed' }
    foreach ($state in @('57014','55P03')) {
        $script:fakeMode = $state; $failure = $null
        try { Read-IndexPreflight 'postgres://probe:synthetic-secret@127.0.0.1:5433/weblens_crawler' $null $null 'SELECT 1' }
        catch { $failure = $_.Exception.Message }
        if ($failure -ne "Read-only preflight failed; SQLSTATE=$state") { throw 'SQL error suppressed or leaked' }
        if ($env:PGPASSWORD -ne 'original-test-secret' -or $env:PGOPTIONS -ne 'original-options') { throw 'Environment not restored on failure' }
        $unknown = Read-PreflightScope 'test' 'SELECT 1'
        if ($unknown.status -ne 'UNVERIFIED' -or $unknown.sqlstate -ne $state -or $null -ne $unknown.data) { throw 'Scope error became a false proof' }
    }
    $before = $script:calls
    foreach ($url in @('postgres://probe:synthetic-secret@remote.invalid:5433/weblens_crawler',
        'postgres://probe:synthetic-secret@127.0.0.1:5432/weblens_crawler',
        'postgres://probe:synthetic-secret@127.0.0.1:5433/unknown')) {
        $rejected = $false
        try { Read-IndexPreflight $url $null $null 'SELECT 1' } catch { $rejected = $true }
        if (-not $rejected) { throw 'Unexpected target accepted' }
    }
    if ($script:calls -ne $before) { throw 'Rejected target invoked SQL' }
    $source = [IO.File]::ReadAllText($path)
    if ($source -match '(?im)\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE|INSERT)\s+(TABLE|INDEX|INTO|FROM)\b') {
        throw 'Unexpected mutation statement in read-only diagnostic'
    }
    Write-Output 'PASS: bounded read-only SQL, parsed success, timeout/lock failure, secret/environment guards, rejected targets, syntax'
} finally {
    $env:PGPASSWORD = $savedPassword; $env:PGOPTIONS = $savedOptions
    Remove-Item Function:\Invoke-FakePsql
}
