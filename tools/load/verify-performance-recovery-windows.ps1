[CmdletBinding()]
param(
    [string] $EnvironmentFile = 'C:\ProgramData\WebLens\weblens.env',
    [string] $ReleaseRoot = 'C:\WebLens\current',
    [string] $FixtureRoot = 'C:\ProgramData\WebLens\performance-fixture',
    [string] $Psql = 'C:\WebLens\runtime\postgresql17\bin\psql.exe',
    [switch] $ExplainOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$environment = @{}
foreach ($line in [IO.File]::ReadAllLines($EnvironmentFile)) {
    if ($line -match '^([^#=]+)=(.*)$') { $environment[$Matches[1]] = $Matches[2] }
}

function Read-Backlog([Uri] $Uri, [string] $Username, [string] $Password, [string] $Sql, [string] $Scope) {
    $savedPassword = $env:PGPASSWORD
    $savedOptions = $env:PGOPTIONS
    try {
        $env:PGPASSWORD = $Password
        $env:PGOPTIONS = '-c statement_timeout=2000 -c lock_timeout=500 -c default_transaction_read_only=on'
        if ($ExplainOnly) { $Sql = "EXPLAIN (FORMAT JSON) $Sql" }
        # Windows PowerShell treats native stderr as errors even when redirected.
        $ErrorActionPreference = 'Continue'
        $raw = & $Psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -h $Uri.Host -p $Uri.Port `
            -U $Username -d $Uri.AbsolutePath.Trim('/') -c $Sql 2>&1
        if ($LASTEXITCODE -ne 0) {
            $sqlState = 'unknown'
            foreach ($line in $raw) {
                if ([string]$line -match '(?:ERROR|FATAL):\s*([0-9A-Z]{5})\b') { $sqlState = $Matches[1]; break }
            }
            throw "Read-only recovery query failed: $Scope; SQLSTATE=$sqlState"
        }
        return ($raw -join '') | ConvertFrom-Json
    } finally {
        $env:PGPASSWORD = $savedPassword
        $env:PGOPTIONS = $savedOptions
    }
}

function Get-ExplainPlans($Value) {
    if ($null -eq $Value -or @($Value).Count -eq 0) { throw 'EXPLAIN returned no plan.' }
    foreach ($item in @($Value)) {
        if ($null -ne $item.Plan) {
            $item
        } elseif ($null -ne $item.value) {
            # Windows PowerShell can serialize a pipeline array as value/Count.
            Get-ExplainPlans $item.value
        } else {
            throw 'EXPLAIN returned an unrecognized plan shape.'
        }
    }
}

$control = Read-Backlog -Scope 'Control' ([Uri]$environment.DB_URL.Replace('jdbc:', '')) `
    $environment.DB_USERNAME $environment.DB_PASSWORD @'
SELECT json_build_object(
 'activeScans',(SELECT count(*) FROM scans WHERE status IN ('QUEUED','RUNNING','CANCEL_REQUESTED')),
 'outboxBacklog',(SELECT count(*) FROM outbox_events WHERE status IN ('PENDING','CLAIMED','DEAD'))
)::text;
'@
$crawlerUri = [Uri]$environment.CRAWLER_POSTGRES_URL
$auth = $crawlerUri.UserInfo.Split(':', 2)
$crawler = Read-Backlog -Scope 'Crawler' $crawlerUri ([Uri]::UnescapeDataString($auth[0])) ([Uri]::UnescapeDataString($auth[1])) @'
SELECT json_build_object(
 'activeExecutions',(SELECT count(*) FROM crawl_executions WHERE status IN ('QUEUED','RUNNING','CANCEL_REQUESTED','INDEXING')),
 'queued',(SELECT count(*) FROM scan_pages WHERE status='QUEUED'),
 'leased',(SELECT count(*) FROM scan_pages WHERE status='LEASED'),
 'persisting',(SELECT COALESCE(sum(persisting_count),0) FROM crawl_executions WHERE status IN ('QUEUED','RUNNING','CANCEL_REQUESTED','INDEXING')),
 'hostLeases',(SELECT count(*) FROM host_leases WHERE lease_owner IS NOT NULL),
 'analyticsBacklog',(SELECT count(*) FROM analytics_outbox WHERE status IN ('PENDING','CLAIMED','DEAD')),
 'eventBacklog',((SELECT count(*) FROM outbox_events WHERE status='PENDING')+(SELECT count(*) FROM outbox_events WHERE status='CLAIMED')),
 'eventDeadBacklog',NULL
)::text;
'@
$captureUri = [Uri]$environment.CAPTURE_DATABASE_URL
$auth = $captureUri.UserInfo.Split(':', 2)
$capture = Read-Backlog -Scope 'Capture' $captureUri ([Uri]::UnescapeDataString($auth[0])) ([Uri]::UnescapeDataString($auth[1])) @'
SELECT json_build_object(
 'activeJobs',(SELECT count(*) FROM capture_jobs WHERE status IN ('QUEUED','RENDERING','PERSISTING')),
 'analyticsBacklog',(SELECT count(*) FROM analytics_outbox WHERE status IN ('PENDING','CLAIMED','DEAD')),
 'eventBacklog',(SELECT count(*) FROM event_outbox WHERE status IN ('PENDING','CLAIMED','DEAD'))
)::text;
'@

if ($ExplainOnly) {
    [ordered]@{ timestampUtc = [DateTime]::UtcNow.ToString('o'); explainOnly = $true
        control = $control; crawler = $crawler; capture = $capture
    } | ConvertTo-Json -Depth 40 -Compress
    exit 0
}

$health = @(foreach ($port in @(8080,8081,8082)) {
    $path = if ($port -eq 8080) { '/actuator/health' } else { '/health/ready' }
    $healthUrl = "http://127.0.0.1:$port$path"
    $startedAtUtc = [DateTime]::UtcNow.ToString('o')
    $healthWatch = [Diagnostics.Stopwatch]::StartNew()
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $raw = & curl.exe --silent --show-error --noproxy '*' --max-time 5 `
            --write-out '|%{http_code}' "http://127.0.0.1:$port$path" 2>$null
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    $healthWatch.Stop()
    $text = $raw -join ''
    $up = $false
    if ($exitCode -eq 0 -and $text -match '^(?<body>.*)\|200$') {
        try { $up = ($Matches.body | ConvertFrom-Json).status -eq 'UP' } catch {}
    }
    $httpCode = $null
    if ($text -match '\|(?<code>[0-9]{3})$') { $httpCode = [int]$Matches.code }
    [pscustomobject]@{ port = $port; url = $healthUrl; startedAtUtc = $startedAtUtc
        elapsedMs = $healthWatch.ElapsedMilliseconds; httpCode = $httpCode; up = $up; curlExit = $exitCode }
})
$collector = Join-Path $FixtureRoot 'collect-windows.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($collector, [ref]$null, [ref]$null)
$function = $ast.Find({param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-BrowserProcessCounts'
}, $true)
if ($null -eq $function) { throw 'Browser attribution function unavailable.' }
Invoke-Expression $function.Extent.Text
$browsers = Get-BrowserProcessCounts @(Get-CimInstance Win32_Process)
$services = @('WebLensPostgres','WebLensBackend','WebLensCrawler','WebLensCapture','WebLensCaddy','WebLensFixture' |
    ForEach-Object { $s = Get-Service $_ -ErrorAction SilentlyContinue
        [pscustomobject]@{ name = $_; running = $null -ne $s -and $s.Status -eq 'Running' }
    })
$caddy = [IO.File]::ReadAllText((Join-Path $ReleaseRoot 'infra\production-windows\Caddyfile'))
$os = Get-CimInstance Win32_OperatingSystem
$result = [ordered]@{
    timestampUtc = [DateTime]::UtcNow.ToString('o')
    control = $control; crawler = $crawler; capture = $capture; health = $health; services = $services
    browsers = $browsers
    memoryUsedPercent = [Math]::Round(100 * (1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize), 2)
    syntheticRouteEnabled = $caddy.Contains('# WEBLENS_LOAD_FIXTURE_BEGIN')
    syntheticHostsEnabled = $caddy.Contains('# WEBLENS_LOAD_HOSTS_BEGIN')
    backendSha256 = (Get-FileHash (Join-Path $ReleaseRoot 'backend\weblens-backend.jar')).Hash.ToLowerInvariant()
    crawlerSha256 = (Get-FileHash (Join-Path $ReleaseRoot 'crawler\weblens-crawler.exe')).Hash.ToLowerInvariant()
    unverifiedChecks = @('crawler_event_outbox_DEAD_without_status_index', 'orphan_PERSISTING_pages_outside_active_executions')
}
$backlogRecovered = $true
foreach ($map in @($control,$crawler,$capture)) {
    foreach ($property in $map.PSObject.Properties) {
        if ($null -ne $property.Value -and $property.Value -ne 0) { $backlogRecovered = $false }
    }
}
$result.observedWorkloadRecovered = $backlogRecovered -and @($health | Where-Object up -ne $true).Count -eq 0 -and
    @($services | Where-Object running -ne $true).Count -eq 0 -and
    $browsers.weblens -eq 0 -and $browsers.unknown -eq 0
$result.globalRecoveryVerified = $result.observedWorkloadRecovered -and $result.unverifiedChecks.Count -eq 0
$result | ConvertTo-Json -Depth 8 -Compress
