[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $OutputPath,
    [ValidateRange(0, 86400)] [int] $DurationSeconds = 60,
    [ValidateRange(1, 60)] [int] $IntervalSeconds = 5,
    [switch] $ProductionTelemetry,
    [string] $StopFile,
    [string] $EnvironmentFile = 'C:\ProgramData\WebLens\weblens.env',
    [string] $PostgresBin = 'C:\WebLens\runtime\postgresql17\bin',
    [string] $ActuatorBaseUrl = 'http://127.0.0.1:8080/actuator'
)

$ErrorActionPreference = 'Stop'

function Read-EnvironmentFile([string] $Path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $values }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1)
    }
    return $values
}

function Get-EnvironmentValue([hashtable] $Values, [string] $Name) {
    if ($Values.ContainsKey($Name)) { return [string]$Values[$Name] }
    return $null
}

function ConvertTo-PostgresConnection([string] $Url, [string] $Username, [string] $Password) {
    if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
    if ($Url -match '^jdbc:postgresql://(?<host>\[[^\]]+\]|[^:/?#]+)(:(?<port>\d+))?/(?<database>[^?]+)') {
        return [pscustomobject]@{
            host = $Matches.host.Trim('[', ']')
            port = if ($Matches.port) { [int]$Matches.port } else { 5432 }
            database = [Uri]::UnescapeDataString($Matches.database)
            username = $Username
            password = $Password
        }
    }
    try {
        $uri = [Uri]$Url
        $userInfo = @($uri.UserInfo.Split(':', 2))
        return [pscustomobject]@{
            host = $uri.Host
            port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
            database = [Uri]::UnescapeDataString($uri.AbsolutePath.Trim('/'))
            username = if ($userInfo.Count -ge 1) { [Uri]::UnescapeDataString($userInfo[0]) } else { $null }
            password = if ($userInfo.Count -ge 2) { [Uri]::UnescapeDataString($userInfo[1]) } else { $null }
        }
    } catch {
        return $null
    }
}

function Invoke-PostgresJson($Connection, [string] $Sql, [string] $PsqlPath) {
    if ($null -eq $Connection) { return [pscustomobject]@{ status = 'not-configured' } }
    if (-not (Test-Path -LiteralPath $PsqlPath -PathType Leaf)) {
        return [pscustomobject]@{ status = 'psql-missing' }
    }
    $previousPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
    $previousOptions = [Environment]::GetEnvironmentVariable('PGOPTIONS', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $Connection.password, 'Process')
        [Environment]::SetEnvironmentVariable('PGOPTIONS', '-c statement_timeout=2000 -c lock_timeout=500 -c default_transaction_read_only=on', 'Process')
        $arguments = @(
            '-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
            '-h', $Connection.host, '-p', [string]$Connection.port,
            '-U', $Connection.username, '-d', $Connection.database, '-c', $Sql
        )
        $output = & $PsqlPath @arguments 2>$null
        if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ status = 'query-failed' } }
        $json = ([string]::Join('', @($output))).Trim()
        if ([string]::IsNullOrWhiteSpace($json)) { return [pscustomobject]@{ status = 'empty-result' } }
        return $json | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{ status = 'query-failed' }
    } finally {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $previousPassword, 'Process')
        [Environment]::SetEnvironmentVariable('PGOPTIONS', $previousOptions, 'Process')
    }
}

function Get-PostgresSnapshot($Connection, [string] $WorkloadSql, [string] $PsqlPath) {
    $commonSql = @'
SELECT json_build_object(
  'status', 'available',
  'version', current_setting('server_version'),
  'connections', COALESCE((
    SELECT json_object_agg(state_name, connection_count)
    FROM (SELECT COALESCE(state, 'unknown') state_name, count(*) connection_count
          FROM pg_stat_activity WHERE datname = current_database()
          GROUP BY COALESCE(state, 'unknown')) s
  ), '{}'::json),
  'waits', COALESCE((
    SELECT json_object_agg(wait_type, waiter_count)
    FROM (SELECT wait_event_type wait_type, count(*) waiter_count
          FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type IS NOT NULL
          GROUP BY wait_event_type) w
  ), '{}'::json),
  'locksWaiting', (SELECT count(*) FROM pg_locks WHERE NOT granted),
  'database', (SELECT row_to_json(d) FROM (
    SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
           temp_files, temp_bytes, deadlocks, blk_read_time, blk_write_time
    FROM pg_stat_database WHERE datname = current_database()) d),
  'pgStatStatementsEnabled', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')
)::text;
'@
    $common = Invoke-PostgresJson $Connection $commonSql $PsqlPath
    if ($common.status -ne 'available') { return $common }
    $workload = Invoke-PostgresJson $Connection $WorkloadSql $PsqlPath
    if ($common.pgStatStatementsEnabled) {
        $statementSql = @'
SELECT json_build_object(
  'calls', COALESCE(sum(calls), 0),
  'totalExecTimeMs', COALESCE(sum(total_exec_time), 0),
  'meanExecTimeMs', COALESCE(sum(total_exec_time) / NULLIF(sum(calls), 0), 0),
  'maxExecTimeMs', COALESCE(max(max_exec_time), 0),
  'rows', COALESCE(sum(rows), 0)
)::text FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database());
'@
        $statements = Invoke-PostgresJson $Connection $statementSql $PsqlPath
    } else {
        $statements = [pscustomobject]@{ status = 'extension-disabled' }
    }
    return [pscustomobject]@{
        status = 'available'
        version = $common.version
        connections = $common.connections
        waits = $common.waits
        locksWaiting = $common.locksWaiting
        database = $common.database
        statements = $statements
        workload = $workload
    }
}

function Get-ActuatorSnapshot([string] $BaseUrl, [string] $ServiceToken) {
    if ([string]::IsNullOrWhiteSpace($ServiceToken)) { return [pscustomobject]@{ status = 'not-configured' } }
    $headers = @{ 'X-WebLens-Service-Token' = $ServiceToken }
    $metricNames = @(
        'process.cpu.usage', 'system.cpu.usage', 'process.uptime',
        'jvm.memory.used', 'jvm.memory.committed', 'jvm.memory.max',
        'jvm.gc.pause', 'jvm.gc.overhead', 'jvm.gc.memory.allocated',
        'jvm.gc.memory.promoted', 'jvm.gc.live.data.size', 'jvm.gc.max.data.size',
        'jvm.threads.live', 'jvm.threads.peak',
        'hikaricp.connections.active', 'hikaricp.connections.idle',
        'hikaricp.connections.pending', 'hikaricp.connections.max',
        'hikaricp.connections.timeout', 'tomcat.threads.busy',
        'tomcat.threads.current', 'tomcat.threads.config.max', 'http.server.requests'
    )
    try {
        $catalog = Invoke-RestMethod -Method Get -Uri "$($BaseUrl.TrimEnd('/'))/metrics" -Headers $headers -TimeoutSec 3
        $available = @($catalog.names)
        $metrics = [ordered]@{}
        foreach ($name in $metricNames) {
            if ($available -notcontains $name) { continue }
            $metric = Invoke-RestMethod -Method Get -Uri "$($BaseUrl.TrimEnd('/'))/metrics/$name" -Headers $headers -TimeoutSec 3
            $metrics[$name] = [pscustomobject]@{ baseUnit = $metric.baseUnit; measurements = @($metric.measurements) }
        }
        return [pscustomobject]@{ status = 'available'; metrics = $metrics }
    } catch {
        return [pscustomobject]@{ status = 'unavailable' }
    }
}

function Invoke-ClickHouseJsonLines([string] $BaseUrl, [string] $Username, [string] $Password, [string] $Sql) {
    if ([string]::IsNullOrWhiteSpace($BaseUrl) -or [string]::IsNullOrWhiteSpace($Username)) {
        return [pscustomobject]@{ status = 'not-configured' }
    }
    try {
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $pair = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$Username`:$Password"))
        $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $BaseUrl `
            -Headers @{ Authorization = "Basic $pair" } -ContentType 'text/plain; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($Sql)) -TimeoutSec 4
        $content = if ($response.Content -is [byte[]]) {
            [Text.Encoding]::UTF8.GetString($response.Content)
        } else {
            [string]$response.Content
        }
        $rows = @()
        foreach ($line in ($content -split "`r?`n")) {
            if (-not [string]::IsNullOrWhiteSpace($line)) { $rows += ($line | ConvertFrom-Json) }
        }
        $stopwatch.Stop()
        return [pscustomobject]@{ status = 'available'; queryDurationMs = $stopwatch.ElapsedMilliseconds; rows = $rows }
    } catch {
        return [pscustomobject]@{ status = 'unavailable' }
    }
}

function Get-ClickHouseSnapshot([hashtable] $Environment) {
    $clickHouseCrawlSql = @'
SELECT dataset, rows FROM (
  SELECT 'crawl.page_metrics' dataset, count() rows FROM weblens_crawl_analytics.page_metrics
  UNION ALL SELECT 'crawl.findings', count() FROM weblens_crawl_analytics.findings
  UNION ALL SELECT 'crawl.page_links', count() FROM weblens_crawl_analytics.page_links
  UNION ALL SELECT 'crawl.ingestion_receipts', count() FROM weblens_crawl_analytics.ingestion_receipts
) ORDER BY dataset FORMAT JSONEachRow
'@
    $clickHouseCaptureSql = @'
SELECT dataset, rows FROM (
  SELECT 'capture.rendered_page_metrics' dataset, count() rows FROM weblens_capture_analytics.rendered_page_metrics
  UNION ALL SELECT 'capture.network_requests', count() FROM weblens_capture_analytics.network_requests
  UNION ALL SELECT 'capture.captured_resources', count() FROM weblens_capture_analytics.captured_resources
  UNION ALL SELECT 'capture.ingestion_receipts', count() FROM weblens_capture_analytics.ingestion_receipts
) ORDER BY dataset FORMAT JSONEachRow
'@
    $baseUrl = Get-EnvironmentValue $Environment 'CLICKHOUSE_URL'
    return [pscustomobject]@{
        crawl = Invoke-ClickHouseJsonLines $baseUrl `
            (Get-EnvironmentValue $Environment 'CRAWLER_CLICKHOUSE_USERNAME') `
            (Get-EnvironmentValue $Environment 'CRAWLER_CLICKHOUSE_PASSWORD') $clickHouseCrawlSql
        capture = Invoke-ClickHouseJsonLines $baseUrl `
            (Get-EnvironmentValue $Environment 'CLICKHOUSE_USERNAME') `
            (Get-EnvironmentValue $Environment 'CLICKHOUSE_PASSWORD') $clickHouseCaptureSql
    }
}

function Get-BrowserProcessCounts($ProcessRows) {
    $browsers=@($ProcessRows | Where-Object { $_.Name -match '^(firefox|chrome|camoufox|chromium|chrome-headless-shell)(\.exe)?$' })
    # Pinned WebLens browsers live under this root, including orphaned processes.
    # A missing executable path is unknown, never proof that recovery is clean.
    [pscustomobject]@{
        total=$browsers.Count
        weblens=@($browsers | Where-Object { $_.ExecutablePath -match '^C:\\WebLens\\' }).Count
        unknown=@($browsers | Where-Object { [string]::IsNullOrWhiteSpace($_.ExecutablePath) }).Count
        external=@($browsers | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -notmatch '^C:\\WebLens\\' }).Count
    }
}

function Get-HostSnapshot {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { [int]$_.LoadPercentage })
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    try { $diskIo = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter "Name='_Total'" } catch { $diskIo = $null }
    try { $networkRows = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface) } catch { $networkRows = @() }
    $processRows=@(Get-CimInstance Win32_Process)
    $browserCounts=Get-BrowserProcessCounts $processRows
    $processes = @(
        $processRows |
            Where-Object { $_.Name -match '^(java|postgres|redis-server|caddy|weblens-crawler|node|firefox|chrome|camoufox|chromium|chrome-headless-shell|k6)(\.exe)?$' } |
            ForEach-Object {
                [pscustomobject]@{
                    pid = $_.ProcessId
                    parentPid = $_.ParentProcessId
                    name = $_.Name
                    cpuSeconds = [math]::Round(([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000000, 3)
                    workingSetBytes = [int64]$_.WorkingSetSize
                    readBytes = [int64]$_.ReadTransferCount
                    writeBytes = [int64]$_.WriteTransferCount
                    threads = [int]$_.ThreadCount
                    handles = [int]$_.HandleCount
                }
            }
    )
    try {
        $tcpStates = @(Get-NetTCPConnection -ErrorAction Stop | Group-Object State |
            ForEach-Object { [pscustomobject]@{ state = [string]$_.Name; count = $_.Count } })
    } catch { $tcpStates = @() }
    $services = @(
        'WebLensPostgres', 'WebLensRedis', 'WebLensBackend', 'WebLensCrawler', 'WebLensCapture', 'WebLensCaddy', 'WebLensFixture' |
            ForEach-Object {
                $service = Get-Service -Name $_ -ErrorAction SilentlyContinue
                if ($null -ne $service) { [pscustomobject]@{ name = $_; status = [string]$service.Status } }
            }
    )
    return [pscustomobject]@{
        cpuLoadPercent = if ($cpu.Count) { [math]::Round(($cpu | Measure-Object -Average).Average, 1) } else { $null }
        memoryTotalBytes = [int64]$os.TotalVisibleMemorySize * 1024
        memoryFreeBytes = [int64]$os.FreePhysicalMemory * 1024
        diskCFreeBytes = if ($null -ne $disk) { [int64]$disk.FreeSpace } else { $null }
        disk = if ($null -ne $diskIo) { [pscustomobject]@{
            readBytesPerSecond = [int64]$diskIo.DiskReadBytesPersec
            writeBytesPerSecond = [int64]$diskIo.DiskWriteBytesPersec
            queueLength = [double]$diskIo.CurrentDiskQueueLength
            percentTime = [double]$diskIo.PercentDiskTime
        } } else { $null }
        network = [pscustomobject]@{
            receivedBytesPerSecond = [int64](($networkRows | Measure-Object BytesReceivedPersec -Sum).Sum)
            sentBytesPerSecond = [int64](($networkRows | Measure-Object BytesSentPersec -Sum).Sum)
        }
        tcpStates = $tcpStates
        services = $services
        processes = $processes
        browserProcessCount = $browserCounts.total
        weblensBrowserProcessCount = $browserCounts.weblens
        externalBrowserProcessCount = $browserCounts.external
        unknownBrowserProcessCount = $browserCounts.unknown
    }
}

$controlSql = @'
SELECT json_build_object(
  'scansByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM scans GROUP BY status) x),
  'oldestActiveScanAgeSeconds', (SELECT extract(epoch FROM now()-min(created_at)) FROM scans WHERE status IN ('QUEUED','RUNNING','CANCEL_REQUESTED')),
  'captureRequestsByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM capture_requests GROUP BY status) x),
  'siteCloneRequestsByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM site_clone_requests GROUP BY status) x),
  'outboxByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM outbox_events GROUP BY status) x),
  'outboxOldestPendingAgeSeconds', (SELECT extract(epoch FROM now()-min(created_at)) FROM outbox_events WHERE status IN ('PENDING','CLAIMED')),
  'outboxDeliveryAttemptsTotal', (SELECT COALESCE(sum(delivery_attempts),0) FROM outbox_events),
  'outboxRetryAttemptsTotal', (SELECT COALESCE(sum(greatest(delivery_attempts-1,0)),0) FROM outbox_events)
)::text;
'@

$crawlerSql = @'
SELECT json_build_object(
  'executionsByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM crawl_executions GROUP BY status) x),
  'oldestActiveExecutionAgeSeconds', (SELECT extract(epoch FROM now()-min(accepted_at)) FROM crawl_executions WHERE status IN ('QUEUED','RUNNING','CANCEL_REQUESTED','INDEXING')),
  'pagesByStatus', (SELECT json_build_object(
      'QUEUED', COALESCE(sum(queued_count),0),
      'LEASED', COALESCE(sum(leased_count),0),
      'PERSISTING', COALESCE(sum(persisting_count),0),
      'SUCCEEDED', COALESCE(sum(succeeded_count),0),
      'FAILED', COALESCE(sum(failed_count),0))
      FROM crawl_executions WHERE status IN ('QUEUED','RUNNING','CANCEL_REQUESTED','INDEXING')),
  'pageAttemptsTotal', NULL,
  'pageRetryAttemptsTotal', NULL,
  'retriedPageCount', NULL,
  'oldestQueuedPageAgeSeconds', NULL,
  'activeHostLeases', (SELECT count(*) FROM host_leases WHERE lease_owner IS NOT NULL),
  'analyticsOutboxByStatus', NULL,
  'analyticsUnpublishedPages', (SELECT COALESCE(sum(analytics_expected_count-analytics_published_count),0)
      FROM crawl_executions WHERE status IN ('QUEUED','RUNNING','CANCEL_REQUESTED','INDEXING')),
  'analyticsDeliveryAttemptsTotal', NULL,
  'analyticsRetryAttemptsTotal', NULL,
  'eventOutboxByStatus', NULL,
  'eventDeliveryAttemptsTotal', NULL,
  'eventRetryAttemptsTotal', NULL
)::text;
'@

$captureSql = @'
SELECT json_build_object(
  'jobsByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM capture_jobs GROUP BY status) x),
  'oldestActiveJobAgeSeconds', (SELECT extract(epoch FROM now()-min(accepted_at)) FROM capture_jobs WHERE status IN ('QUEUED','RENDERING','PERSISTING')),
  'jobAttemptsTotal', (SELECT COALESCE(sum(attempt_count),0) FROM capture_jobs),
  'jobRetryAttemptsTotal', (SELECT COALESCE(sum(greatest(attempt_count-1,0)),0) FROM capture_jobs),
  'snapshots', (SELECT json_build_object('count',count(*),'htmlBytes',COALESCE(sum(html_bytes),0),'screenshotBytes',COALESCE(sum(screenshot_bytes),0)) FROM page_snapshots),
  'analyticsOutboxByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM analytics_outbox GROUP BY status) x),
  'analyticsDeliveryAttemptsTotal', (SELECT COALESCE(sum(delivery_attempts),0) FROM analytics_outbox),
  'analyticsRetryAttemptsTotal', (SELECT COALESCE(sum(greatest(delivery_attempts-1,0)),0) FROM analytics_outbox),
  'eventOutboxByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM event_outbox GROUP BY status) x),
  'eventDeliveryAttemptsTotal', (SELECT COALESCE(sum(delivery_attempts),0) FROM event_outbox),
  'eventRetryAttemptsTotal', (SELECT COALESCE(sum(greatest(delivery_attempts-1,0)),0) FROM event_outbox),
  'siteJobsByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM site_reconstruction_jobs GROUP BY status) x),
  'sitePagesByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM site_reconstruction_pages GROUP BY status) x),
  'sitePageAttemptsTotal', (SELECT COALESCE(sum(attempt_count),0) FROM site_reconstruction_pages),
  'sitePageRetryAttemptsTotal', (SELECT COALESCE(sum(greatest(attempt_count-1,0)),0) FROM site_reconstruction_pages),
  'siteEventOutboxByStatus', (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,count(*) n FROM site_reconstruction_event_outbox GROUP BY status) x)
)::text;
'@

$target = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.File]::Exists($target)) { throw "Output already exists: $target" }
$parent = [System.IO.Path]::GetDirectoryName($target)
if (-not [string]::IsNullOrWhiteSpace($parent)) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
$writer = [System.IO.StreamWriter]::new($target, $false, [System.Text.UTF8Encoding]::new($false))
$deadline = [DateTime]::UtcNow.AddSeconds($DurationSeconds)
$environment = if ($ProductionTelemetry) { Read-EnvironmentFile $EnvironmentFile } else { @{} }
$psql = Join-Path $PostgresBin 'psql.exe'
$controlConnection = ConvertTo-PostgresConnection `
    (Get-EnvironmentValue $environment 'DB_URL') `
    (Get-EnvironmentValue $environment 'DB_USERNAME') `
    (Get-EnvironmentValue $environment 'DB_PASSWORD')
$crawlerConnection = ConvertTo-PostgresConnection (Get-EnvironmentValue $environment 'CRAWLER_POSTGRES_URL') $null $null
$captureConnection = ConvertTo-PostgresConnection (Get-EnvironmentValue $environment 'CAPTURE_DATABASE_URL') $null $null

try {
    do {
        $sample = [ordered]@{ schemaVersion = 2; timestampUtc = [DateTime]::UtcNow.ToString('o'); host = Get-HostSnapshot }
        if ($ProductionTelemetry) {
            $sample.actuator = Get-ActuatorSnapshot $ActuatorBaseUrl (Get-EnvironmentValue $environment 'WEBLENS_SERVICE_TOKEN')
            $sample.postgres = [pscustomobject]@{
                control = Get-PostgresSnapshot $controlConnection $controlSql $psql
                crawler = Get-PostgresSnapshot $crawlerConnection $crawlerSql $psql
                capture = Get-PostgresSnapshot $captureConnection $captureSql $psql
            }
            $sample.clickHouse = Get-ClickHouseSnapshot $environment
            $sample.objectStorage = [pscustomobject]@{
                providerMetrics = 'not-available'
                source = 'capture PostgreSQL reference counters only'
            }
        }
        $writer.WriteLine(($sample | ConvertTo-Json -Depth 12 -Compress))
        $writer.Flush()
        if (-not [string]::IsNullOrWhiteSpace($StopFile) -and (Test-Path -LiteralPath $StopFile -PathType Leaf)) { break }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds $IntervalSeconds
    } while ($true)
} finally {
    $writer.Dispose()
}
