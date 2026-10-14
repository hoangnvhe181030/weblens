[CmdletBinding()]
param(
    [string]$Reports = "$PSScriptRoot/../backend/target/failsafe-reports",
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

function Assert-ExecutedSuite([xml]$Report, [string]$Name) {
    $suite = $Report.testsuite
    if (-not $suite -or $suite.name -ne $Name -or [int]$suite.tests -lt 1 -or
        [int]$suite.skipped -ne 0 -or [int]$suite.failures -ne 0 -or [int]$suite.errors -ne 0) {
        throw "Critical integration suite missing, skipped or failed: $Name"
    }
}

if ($SelfTest) {
    Assert-ExecutedSuite ([xml]'<testsuite name="example" tests="1" skipped="0" failures="0" errors="0"/>') 'example'
    foreach ($sample in @(
        '<testsuite name="example" tests="0" skipped="0" failures="0" errors="0"/>',
        '<testsuite name="example" tests="1" skipped="1" failures="0" errors="0"/>',
        '<testsuite name="example" tests="1" skipped="0" failures="1" errors="0"/>',
        '<testsuite name="other" tests="1" skipped="0" failures="0" errors="0"/>'
    )) {
        $rejected = $false
        try { Assert-ExecutedSuite ([xml]$sample) 'example' } catch { $rejected = $true }
        if (-not $rejected) { throw 'Evidence gate accepted an invalid report' }
    }
    Write-Output 'PASS: integration evidence gate self-test'
    return
}

foreach ($name in @(
    'com.weblens.api.FoundationApiIT',
    'com.weblens.auth.service.AuthenticationPersistenceIT',
    'com.weblens.auth.security.RedisSessionStoreIT',
    'com.weblens.persistence.FoundationPersistenceIT',
    'com.weblens.scan.service.ScanCancellationIT',
    'com.weblens.messaging.ControlMessagingRepositoryIT',
    'com.weblens.messaging.DispatchCrashRecoveryIT'
)) {
    $path = Join-Path $Reports "TEST-$name.xml"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing integration evidence: $name" }
    Assert-ExecutedSuite ([xml](Get-Content -LiteralPath $path -Raw)) $name
}
Write-Output 'PASS: all critical backend integration suites executed without skips'
