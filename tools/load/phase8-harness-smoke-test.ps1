[CmdletBinding()]
param([string] $HarnessPath = '',
    [ValidateSet(150,500)][int]$ScanCount = 150)
$ErrorActionPreference = 'Stop'
if (-not $HarnessPath) { $HarnessPath = Join-Path $PSScriptRoot '..\..\tmp\load\phase8-run-150x1000.ps1' }
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HarnessPath, [ref]$null, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Read-SubmissionObservations','Get-AdmissionContinuation','Get-ResourceStopReasons','Get-OwnedScanHistory','Reconcile-AdmittedScans',
                    'Assert-TelemetryReady','Get-MetricValue','Get-MapValue','Cancel-RemainingScans','Wait-RemainingTerminal','Clear-TerminalCredentials')) {
    $function = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if ($null -eq $function) { throw "Missing harness function $name" }
    Invoke-Expression $function.Extent.Text
}
function Assert($Condition, [string] $Message) { if (-not $Condition) { throw $Message } }
function Must-Fail([scriptblock] $Action, [string] $Message) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Assert $failed $Message
}
function Write-JsonFile([string] $Path, $Value) { $script:lastArtifact = $Value | ConvertTo-Json -Depth 20 }
function Require-Status($Response, [int[]] $Expected, [string] $Action) {
    if ($Response.Status -notin $Expected) { throw "$Action failed" }
    return $Response.Body
}
function Login-Account([int] $Index) { return "owner-$Index" }

$overloaded = @{vpsCpuMaxPercent=99;vpsMemoryRatioMax=0.99;generatorCpuMaxPercent=99;generatorMemoryRatioMax=0.99}
Assert (@(Get-ResourceStopReasons $overloaded $false).Count -eq 4) 'Strict resource acceptance gates changed'
Assert (@(Get-ResourceStopReasons $overloaded $true).Count -eq 0) 'User-waived resource gates still fail acceptance'

$site = [Guid]::NewGuid().ToString()
$scanId = [Guid]::NewGuid().ToString()
$planned = [DateTimeOffset]::UtcNow.AddSeconds(-2).ToString('o')
$requestIdentities = @([pscustomobject]@{
    index = 0; accountIndex = 7; websiteId = $site; idempotencyKey = 'run-150-0'; plannedAtUtc = $planned
})
$pollTokens = @{}
$remaining = @{}
$knownAdmissions = @{}
$reconciliation = @{}
$finalScans = [Collections.Generic.List[object]]::new()
$terminalStatuses = @('COMPLETED','PARTIAL_SUCCESS','FAILED','CANCELLED')
$levelDirectory = 'mock-output'
$calls = [Collections.Generic.List[object]]::new()
$historyMode = 'committed'
$refreshOnce = $false
function Invoke-WebLens([string] $Method, [string] $Path, [string] $Token) {
    $calls.Add(@{ method = $Method; path = $Path; token = $Token })
    Assert ($Token -eq 'owner-7') 'Cross-owner token used'
    if ($Path -eq "/api/v1/websites/$site/scans?page=0&size=2" -and $Method -eq 'GET') {
        if ($script:refreshOnce) { $script:refreshOnce = $false; return @{ Status = 401 } }
        if ($historyMode -eq 'unavailable') { throw 'No response' }
        $row = @{ id = $scanId; websiteId = $site; createdAt = [DateTimeOffset]::UtcNow.ToString('o') }
        if ($historyMode -eq 'wrong-site') { $row.websiteId = [Guid]::NewGuid().ToString() }
        if ($historyMode -eq 'old-row') { $row.createdAt = [DateTimeOffset]::UtcNow.AddDays(-1).ToString('o') }
        if ($historyMode -eq 'absent') { return @{ Status = 200; Body = @{ page = 0; items = @(); totalItems = 0 } } }
        if ($historyMode -eq 'ambiguous') { return @{ Status = 200; Body = @{ page = 0; items = @($row,$row); totalItems = 2 } } }
        return @{ Status = 200; Body = @{ page = 0; items = @($row); totalItems = 1 } }
    }
    if ($Path -eq "/api/v1/scans/$scanId/cancellations" -and $Method -eq 'POST') { return @{ Status = 202 } }
    if ($Path -eq "/api/v1/scans/$scanId" -and $Method -eq 'GET') {
        return @{ Status = 200; Body = @{ status = 'CANCELLED'; websiteId = $site; createdAt = $planned } }
    }
    throw 'Unexpected request; never replay POST admission or use another website'
}

$observations = @(Read-SubmissionObservations @("PHASE5_SCAN|0|7||0|5000.01", "PHASE5_SCAN|1|8|$([Guid]::NewGuid())|202|120.0"))
Assert ($observations.Count -eq 2 -and $observations[0].status -eq 0 -and -not $observations[0].scanId) 'Timeout observation lost'
Must-Fail { $null = Read-SubmissionObservations @('PHASE5_SCAN|0|7||0|5.1','PHASE5_SCAN|0|7||0|5.1') } 'Duplicate observation accepted'
Must-Fail { $null = Read-SubmissionObservations @('PHASE5_SCAN|0|7||0|5.1|broken') } 'Malformed extended diagnostic silently treated as legacy'
$transport = @(Read-SubmissionObservations @('PHASE5_SCAN|334|334||0|0|5004|1050|0|1031|0|0|0|0|run-admission-334'))
Assert ($transport.Count -eq 1 -and $transport[0].elapsedMs -eq 5004 -and $transport[0].durationMs -eq 0) 'Transport timeout elapsed was lost'
Assert ($transport[0].transportErrorCode -eq 1050 -and $transport[0].correlationId -eq 'run-admission-334') 'Transport diagnostic was lost'
Assert ($transport[0].timings.connectingMs -eq 1031 -and $null -eq $observations[0].elapsedMs) 'New or legacy timing semantics changed'
$quotedTransport = @(Read-SubmissionObservations @('time="2026-10-01" msg="PHASE5_SCAN|334|334||0|0|5004|1050|0|1031|0|0|0|0|run-admission-334" source=console'))
Assert ($quotedTransport.Count -eq 1 -and $quotedTransport[0].elapsedMs -eq 5004) 'Quoted k6 diagnostic could not be parsed'
$decision = Get-AdmissionContinuation 500 498 498 99 $false $true
Assert ($decision.runMixed -and -not $decision.stopReason) 'Verified partial admission cannot continue'
Assert (-not (Get-AdmissionContinuation 500 498 498 99 $true $false).runMixed) 'Strict admission was relaxed without opting in'
Assert (-not (Get-AdmissionContinuation 500 0 0 99 $true $true).runMixed) 'Zero verified scans admitted'
Assert (-not (Get-AdmissionContinuation 500 498 498 1 $true $true).runMixed) 'Fatal k6 process failure admitted'
Assert (-not (Get-AdmissionContinuation 500 498 499 0 $true $true).runMixed) 'Invalid admission cardinality admitted'
Assert ((Get-AdmissionContinuation 500 500 500 0 $false $false).runMixed) 'Successful strict admission was blocked'
$refreshOnce = $true
Reconcile-AdmittedScans
Assert ($remaining.Count -eq 1 -and $knownAdmissions.Count -eq 1) 'Committed timeout was not recovered'
Assert ($observations[0].status -eq 0) 'Recovery changed client success/error evidence'
Assert (-not $lastArtifact.Contains('owner-7')) 'Token leaked into reconciliation artifact'
Cancel-RemainingScans
Wait-RemainingTerminal 1
Assert ($remaining.Count -eq 0 -and $finalScans.Count -eq 1) 'Recovered scan not cancelled and verified terminal'
$callCount = $calls.Count
Reconcile-AdmittedScans
Assert ($calls.Count -eq $callCount) 'Completed reconciliation repeated requests'
foreach ($mode in @('absent','ambiguous','wrong-site','old-row','unavailable')) {
    $historyMode = $mode
    $knownAdmissions = @{}; $remaining = @{}; $reconciliation = @{}
    $finalScans = [Collections.Generic.List[object]]::new()
    Reconcile-AdmittedScans
    Assert ($remaining.Count -eq 0 -and $reconciliation['0'].outcome -eq 'UNRESOLVED') "Unsafe reconciliation accepted $mode"
}

# Preserve the original failure shape; also check a 500-user run with 29 committed timeouts.
$acknowledgedCount = $ScanCount - 29
$requestIdentities = @(0..($ScanCount-1) | ForEach-Object {
    [pscustomobject]@{ index = $_; accountIndex = $_; websiteId = [Guid]::NewGuid().ToString()
        idempotencyKey = "run-$ScanCount-$_"; plannedAtUtc = $planned }
})
$siteRows = @{}; $scanRows = @{}
$knownAdmissions = @{}; $remaining = @{}; $reconciliation = @{}; $pollTokens = @{}
$finalScans = [Collections.Generic.List[object]]::new()
$calls = [Collections.Generic.List[object]]::new()
$lines = @(foreach ($identity in $requestIdentities) {
    $id = [Guid]::NewGuid().ToString()
    $row = @{ id = $id; websiteId = $identity.websiteId; accountIndex = $identity.accountIndex
        createdAt = [DateTimeOffset]::UtcNow.ToString('o') }
    $siteRows[$identity.websiteId] = $row; $scanRows[$id] = $row
    $pollTokens[[string]$identity.accountIndex] = "owner-$($identity.accountIndex)"
    if ($identity.index -lt $acknowledgedCount) {
        $scan = [pscustomobject]@{ index = $identity.index; accountIndex = $identity.accountIndex
            scanId = $id; websiteId = $identity.websiteId; durationMs = 100 }
        $knownAdmissions[[string]$identity.index] = $scan; $remaining[$id] = $scan
        "PHASE5_SCAN|$($identity.index)|$($identity.accountIndex)|$id|202|100.0"
    } else { "PHASE5_SCAN|$($identity.index)|$($identity.accountIndex)||0|4800.0" }
})
function Invoke-WebLens([string] $Method, [string] $Path, [string] $Token) {
    $calls.Add(@{ method = $Method; path = $Path; token = $Token })
    if ($Method -eq 'GET' -and $Path -match '^/api/v1/websites/([0-9a-f-]{36})/scans\?page=0&size=2$') {
        $row = $siteRows[$Matches[1]]
        Assert ($null -ne $row -and $Token -eq "owner-$($row.accountIndex)") 'Wrong owner/site in 150-row reconciliation'
        return @{ Status = 200; Body = @{ page = 0; items = @($row); totalItems = 1 } }
    }
    if ($Path -match '^/api/v1/scans/([0-9a-f-]{36})(/cancellations)?$') {
        $row = $scanRows[$Matches[1]]; $cancellation = $Matches[2]
        Assert ($null -ne $row -and $Token -eq "owner-$($row.accountIndex)") 'Wrong owner in 150-row cleanup'
        if ($Method -eq 'POST' -and $cancellation) { return @{ Status = 202 } }
        if ($Method -eq 'GET' -and -not $cancellation) {
            return @{ Status = 200; Body = @{ status = 'CANCELLED'; websiteId = $row.websiteId; createdAt = $row.createdAt } }
        }
    }
    throw 'Unexpected request during 150-row cleanup'
}
$observations = @(Read-SubmissionObservations $lines)
Reconcile-AdmittedScans
Assert ($knownAdmissions.Count -eq $ScanCount -and $remaining.Count -eq $ScanCount -and $reconciliation.Count -eq 29) 'Reconciliation lost committed scans'
Assert (@($observations | Where-Object status -eq 202).Count -eq $acknowledgedCount -and @($observations | Where-Object status -eq 0).Count -eq 29) 'Client timeout metrics were rewritten'
Cancel-RemainingScans
Wait-RemainingTerminal 1
Assert ($finalScans.Count -eq $ScanCount -and $remaining.Count -eq 0) 'Cleanup did not verify every terminal scan'
Assert (@($calls | Where-Object { $_.method -eq 'POST' -and $_.path -notlike '*/cancellations' }).Count -eq 0) 'Admission POST replayed'

$notBefore = [DateTimeOffset]::UtcNow.AddSeconds(-10)
$sample = @{
    schemaVersion = 2; timestampUtc = [DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o')
    host = @{ cpuLoadPercent = 5; memoryTotalBytes = 100; memoryFreeBytes = 35
        unknownBrowserProcessCount = 0; weblensBrowserProcessCount = 0
        services = @('WebLensPostgres','WebLensBackend','WebLensCrawler','WebLensCapture','WebLensCaddy','WebLensFixture' |
            ForEach-Object { @{ name = $_; status = 'Running' } }) }
    actuator = @{ status = 'available'; metrics = @{ 'hikaricp.connections.pending' = @{ measurements = @(@{ statistic = 'VALUE'; value = 0 }) } } }
    postgres = @{
        control = @{ status = 'available'; workload = @{ scansByStatus = @{}; outboxByStatus = @{} } }
        crawler = @{ status = 'available'; workload = @{ executionsByStatus = @{}; pagesByStatus = @{}; activeHostLeases = 0; analyticsUnpublishedPages = 0 } }
        capture = @{ status = 'available' }
    }
    clickHouse = @{ crawl = @{ status = 'available' }; capture = @{ status = 'available' } }
} | ConvertTo-Json -Depth 12 | ConvertFrom-Json
$first = $sample | ConvertTo-Json -Depth 12 | ConvertFrom-Json
$first.timestampUtc = [DateTimeOffset]::UtcNow.AddSeconds(-3).ToString('o')
Assert-TelemetryReady @($first,$sample) @($first,$sample) $notBefore
Must-Fail { Assert-TelemetryReady @($sample) @($first,$sample) $notBefore } 'Single telemetry sample admitted'
foreach ($case in @('stale','unavailable','missing','overloaded','backlog','unknown-browser')) {
    $bad = $sample | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    switch ($case) {
        'stale' { $bad.timestampUtc = [DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o') }
        'unavailable' { $bad.postgres.control.status = 'unavailable' }
        'missing' { $bad.actuator.metrics.PSObject.Properties.Remove('hikaricp.connections.pending') }
        'overloaded' { $bad.host.memoryFreeBytes = 10 }
        'backlog' { $bad.postgres.crawler.workload.activeHostLeases = 1 }
        'unknown-browser' { $bad.host.unknownBrowserProcessCount = 1 }
    }
    Must-Fail { Assert-TelemetryReady @($first,$bad) @($first,$sample) $notBefore } "Invalid telemetry admitted: $case"
}
Must-Fail { Assert-TelemetryReady @($sample,$sample) @($first,$sample) $notBefore } 'Repeated telemetry sample admitted'
foreach ($source in @(
    @{ path = (Join-Path $PSScriptRoot 'verify-performance-recovery-windows.ps1'); name = 'Get-ExplainPlans' },
    @{ path = (Join-Path $PSScriptRoot '..\..\tmp\load\phase3-backlog-index-probe.ps1'); name = 'Assert-PagePlan' }
)) {
    $planAst = [Management.Automation.Language.Parser]::ParseFile($source.path, [ref]$null, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    $function = $planAst.Find({param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $source.name
    }, $true)
    if ($null -eq $function) { throw "Missing plan function $($source.name)" }
    Invoke-Expression $function.Extent.Text
}
$safePlan = [pscustomobject]@{Plan = [pscustomobject]@{
    'Node Type' = 'Index Scan'; 'Relation Name' = 'scan_pages_2026_09'; 'Total Cost' = 8
}}
$unsafePlan = [pscustomobject]@{Plan = [pscustomobject]@{
    'Node Type' = 'Aggregate'; Plans = @([pscustomobject]@{
        'Node Type' = 'Seq Scan'; 'Relation Name' = 'scan_pages_2026_09'; 'Total Cost' = 500
    })
}}
foreach ($shape in @(@($safePlan), [pscustomobject]@{value = @($safePlan); Count = 1})) {
    $plans = @(Get-ExplainPlans $shape)
    Assert ($plans.Count -eq 1) 'EXPLAIN plan was silently skipped'
    foreach ($plan in $plans) { Assert-PagePlan $plan.Plan }
}
foreach ($shape in @(@($unsafePlan), [pscustomobject]@{value = @($unsafePlan); Count = 1})) {
    Must-Fail { foreach ($plan in @(Get-ExplainPlans $shape)) { Assert-PagePlan $plan.Plan } } 'History scan passed wrapped plan gate'
}
Must-Fail { Get-ExplainPlans $null } 'Missing EXPLAIN accepted'
Must-Fail { Get-ExplainPlans ([pscustomobject]@{Count = 1}) } 'Unknown EXPLAIN shape accepted'
Must-Fail { Assert-PagePlan $null } 'Missing plan node accepted'
Must-Fail { Assert-PagePlan ([pscustomobject]@{'Node Type' = 'Seq Scan'; 'Relation Name' = 'scan_pages_2026_09'}) } 'Unknown scan cost accepted'

$wrapperPath = Join-Path $PSScriptRoot '..\..\tmp\load\phase8-scheduled-run-150.ps1'
$wrapperAst = [Management.Automation.Language.Parser]::ParseFile($wrapperPath, [ref]$null, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$gate = $wrapperAst.Find({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-PreLoadProof'
}, $true)
Assert ($null -ne $gate) 'Missing pre-load proof gate'
Invoke-Expression $gate.Extent.Text
$proof = [pscustomobject]@{
    globalRecoveryVerified = $true; syntheticRouteEnabled = $false; syntheticHostsEnabled = $false
    memoryUsedPercent = 70; timestampUtc = [DateTimeOffset]::UtcNow.ToString('o')
}
Assert-PreLoadProof $proof
foreach ($case in @('unknown','missing','string','route','hosts','memory','missing-memory','negative-memory','stale','future','invalid-time')) {
    $bad = $proof | ConvertTo-Json | ConvertFrom-Json
    switch ($case) {
        'unknown' { $bad.globalRecoveryVerified = $false }
        'missing' { $bad.PSObject.Properties.Remove('globalRecoveryVerified') }
        'string' { $bad.globalRecoveryVerified = 'true' }
        'route' { $bad.syntheticRouteEnabled = $true }
        'hosts' { $bad.syntheticHostsEnabled = $true }
        'memory' { $bad.memoryUsedPercent = 85 }
        'missing-memory' { $bad.PSObject.Properties.Remove('memoryUsedPercent') }
        'negative-memory' { $bad.memoryUsedPercent = -1 }
        'stale' { $bad.timestampUtc = [DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o') }
        'future' { $bad.timestampUtc = [DateTimeOffset]::UtcNow.AddMinutes(2).ToString('o') }
        'invalid-time' { $bad.timestampUtc = 'invalid' }
    }
    Must-Fail { Assert-PreLoadProof $bad } "Pre-load gate accepted $case"
}

# Exercise the wrapper itself with an unknown global proof and forbidden mutations.
function scp.exe { $global:LASTEXITCODE = 0 }
function ssh.exe {
    $global:LASTEXITCODE = 0
    [pscustomobject]@{
        globalRecoveryVerified = $false; syntheticRouteEnabled = $false; syntheticHostsEnabled = $false
        memoryUsedPercent = 70; timestampUtc = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress
}
function Start-Process { throw 'Preflight attempted a process mutation' }
$mockWrapper = $wrapperAst.Extent.Text.Replace("if (`$failed -or `$rollbackFailed) { exit 1 }", "if (-not `$failed -or `$routeAttempted) { throw 'Unknown recovery was not blocked before routes' }")
$mockWrapper = $mockWrapper.Replace(". (Join-Path `$root 'tools\load\performance-failure-diagnostic.ps1')", '')
# Simulate the supported host for offline business checks; the real wrapper still requires PS7.
$versionCheck = "if (`$PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }"
Assert ($wrapperAst.Extent.Text.Contains($versionCheck)) 'Wrapper lost supported-host check'
$mockWrapper = $mockWrapper.Replace($versionCheck, '')
. (Join-Path $PSScriptRoot 'performance-failure-diagnostic.ps1')
$mockWrapper = $mockWrapper.Replace("`$statePath = Join-Path `$root", "`$statePath = Join-Path `$TestDrive")
$mockWrapper = $mockWrapper.Replace('(Join-Path $root "tmp\load\phase8-$RunLabel-preflight-$attempt.json")', '(Join-Path $TestDrive "tmp\load\phase8-$RunLabel-preflight-$attempt.json")')
$TestDrive = Join-Path ([IO.Path]::GetTempPath()) ("weblens-offline-" + [Guid]::NewGuid())
[void][IO.Directory]::CreateDirectory((Join-Path $TestDrive 'tmp\load'))
try {
    & ([scriptblock]::Create($mockWrapper)) -RunLabel offline-500 -UserCount 500 -WorkerConcurrency 64 -PreflightOnly
    $state = Get-Content (Join-Path $TestDrive 'tmp\load\phase8-scheduled-state-offline-500.json') -Raw | ConvertFrom-Json
    Assert ($state.stage -eq 'PREFLIGHT_BLOCKED') 'Unknown recovery escaped wrapper'
    $script:routeActions = [Collections.Generic.List[string]]::new()
    function ssh.exe {
        $global:LASTEXITCODE = 0
        if ($args -contains '-Action') {
            $action = $args[-1]; $script:routeActions.Add($action)
            @{enabled = ($action -eq 'enable'); serviceRunning = $true; syntheticHostsHealthy = ($action -eq 'enable')} | ConvertTo-Json -Compress
        } else {
            Assert ($script:routeActions -contains 'enable') 'Waived preflight still probed before enabling'
            @{globalRecoveryVerified = $false; syntheticRouteEnabled = $false; syntheticHostsEnabled = $false} | ConvertTo-Json -Compress
        }
    }
    function scp.exe { throw 'Waived run attempted preflight upload' }
    $mockRun = Join-Path $TestDrive 'tmp\load\fake-run'
    [void][IO.Directory]::CreateDirectory($mockRun)
    [IO.File]::WriteAllText((Join-Path $mockRun 'cleanup-state.json'),'{"runTerminalVerified":true,"globalRecoveryVerified":false}')
    $mockHarness = "param(`$RunLabel,`$WorkerConcurrency,`$UserCount,`$CrawlerVariant,[switch]`$SkipOperationalGuards,[switch]`$ContinueVerifiedAdmissions); if (-not `$SkipOperationalGuards -or -not `$ContinueVerifiedAdmissions -or `$UserCount -ne 500) { throw 'Run options not propagated' }; @{outcome='COMPLETED_ALL_LEVELS'; output='$mockRun'} | ConvertTo-Json -Compress"
    [IO.File]::WriteAllText((Join-Path $TestDrive 'tmp\load\phase8-run-150x1000.ps1'),$mockHarness)
    $waivedWrapper = $wrapperAst.Extent.Text.Replace("`$root = 'C:\Users\HP\Desktop\Pet_project'", "`$root = '$TestDrive'")
    $waivedWrapper = $waivedWrapper.Replace(". (Join-Path `$root 'tools\load\performance-failure-diagnostic.ps1')", '')
    $waivedWrapper = $waivedWrapper.Replace($versionCheck, '')
    $waivedWrapper = $waivedWrapper.Replace('if ($failed -or $rollbackFailed) { exit 1 }','')
    & ([scriptblock]::Create($waivedWrapper)) -RunLabel offline-500 -UserCount 500 -WorkerConcurrency 64 -SkipOperationalGuards -ContinueVerifiedAdmissions
    $state = Get-Content (Join-Path $TestDrive 'tmp\load\phase8-scheduled-state-offline-500.json') -Raw | ConvertFrom-Json
    Assert ($state.stage -eq 'RECOVERY_UNVERIFIED' -and $state.operationalGuardsSkippedByUser) 'Waiver falsely certified recovery'
    Assert $state.continueVerifiedAdmissions 'Continuation option was lost from wrapper evidence'
    Assert (($script:routeActions -join ',') -eq 'enable,disable,status') 'Waived run lost route cleanup'
    foreach ($path in @(Get-ChildItem $mockRun -File)) { [IO.File]::Delete($path.FullName) }
    [IO.Directory]::Delete($mockRun)
} finally {
    if ($mockRun -and (Test-Path -LiteralPath $mockRun)) {
        Assert ([IO.Path]::GetFullPath($mockRun).StartsWith([IO.Path]::GetFullPath($TestDrive) + '\', [StringComparison]::OrdinalIgnoreCase)) 'Mock cleanup escaped test directory'
        foreach ($path in @(Get-ChildItem -LiteralPath $mockRun -File)) { Remove-Item -LiteralPath $path.FullName }
        [IO.Directory]::Delete($mockRun)
    }
    foreach ($path in @(Get-ChildItem (Join-Path $TestDrive 'tmp\load') -File)) { [IO.File]::Delete($path.FullName) }
    [IO.Directory]::Delete((Join-Path $TestDrive 'tmp\load'))
    [IO.Directory]::Delete((Join-Path $TestDrive 'tmp'))
    [IO.Directory]::Delete($TestDrive)
    Remove-Item Function:\scp.exe,Function:\ssh.exe,Function:\Start-Process
}

$credentialFile = Join-Path ([IO.Path]::GetTempPath()) ("weblens-offline-" + [Guid]::NewGuid() + '.dpapi')
$seedFile = "$credentialFile.json"
try {
    $cipher = ConvertFrom-SecureString (ConvertTo-SecureString 'offline-only-secret' -AsPlainText -Force)
    [IO.File]::WriteAllText($credentialFile,$cipher)
    [IO.File]::WriteAllText($seedFile,'{"entries":[]}')
    $restored = [Net.NetworkCredential]::new('',(ConvertTo-SecureString $cipher)).Password
    Assert ($restored -eq 'offline-only-secret' -and -not $cipher.Contains($restored)) 'DPAPI round-trip failed'
    $admissionMayHaveStarted = $true; $remaining = @{}; $knownAdmissions = @{}
    $requestIdentities = @([pscustomobject]@{index = 0})
    Assert (-not (Clear-TerminalCredentials $true)) 'Unresolved identity credentials deleted'
    $knownAdmissions['0'] = @{scanId = 'offline'}; $remaining['offline'] = @{}
    Assert (-not (Clear-TerminalCredentials $true)) 'Active scan credentials deleted'
    $remaining.Clear()
    Assert (-not (Clear-TerminalCredentials $false)) 'Missing cleanup evidence credentials deleted'
    Assert ((Test-Path $credentialFile) -and (Test-Path $seedFile)) 'Recovery credentials missing'
    Assert (Clear-TerminalCredentials $true) 'Terminal cleanup failed'
    Assert (-not (Test-Path $credentialFile) -and -not (Test-Path $seedFile)) 'Terminal credentials retained'
} finally {
    foreach ($path in @($credentialFile,$seedFile)) { if (Test-Path $path) { [IO.File]::Delete($path) } }
}
"PASS: $ScanCount scans ($acknowledgedCount acknowledged + 29 committed timeouts) reconciled/cancelled; ownership, unchanged errors, telemetry, EXPLAIN, pre-load refusal and DPAPI cleanup; no network used."
