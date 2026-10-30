[CmdletBinding()]
param(
    [string]$EnvironmentFile = 'C:\ProgramData\WebLens\weblens.env',
    [string]$PostgresBin = 'C:\WebLens\runtime\postgresql17\bin',
    [switch]$SkipDatabaseInventory,
    [switch]$QueryPlans,
    [switch]$SelfTest,
    [ValidateRange(1000,30000)][int]$RedisReadTimeoutMs = 10000
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Protect-RedisError([string]$Reply, [hashtable]$Configuration) {
    $safeError = $Reply.Trim()
    foreach ($value in $Configuration.Values) {
        if ($value.Length -ge 4) { $safeError = $safeError.Replace($value, '[REDACTED]') }
    }
    $safeError = $safeError -replace '[a-zA-Z0-9._-]+\.(dev|com|net|top|cloud)\b','[HOST]' -replace '\b[0-9a-f-]{36}\b','[ID]'
    return $safeError.Substring(0, [Math]::Min(180, $safeError.Length))
}

if ($SelfTest) {
    $safe = Protect-RedisError '-ERR token=test-secret host=example.cloud id=12345678-abcd-1234-abcd-123456789abc' @{ password = 'test-secret' }
    if ($safe -match 'test-secret|example\.cloud|12345678-abcd' -or $safe -notmatch '\[REDACTED\].*\[HOST\].*\[ID\]') {
        throw 'Redis diagnostic redaction failed'
    }
    if ((Protect-RedisError ('x' * 300) @{}).Length -ne 180) { throw 'Redis diagnostic length limit failed' }
    $sleep = '-ERR This database is held asleep under the Free-plan sleep requirement.'
    if ((Protect-RedisError $sleep @{}) -ne $sleep) { throw 'Public provider explanation was lost' }
    Write-Output 'PASS: diagnostic redaction and length-limit self-test (no environment/network access)'
    return
}

$values = @{}
foreach ($line in [IO.File]::ReadAllLines($EnvironmentFile)) {
    if ($line -match '^([^#=]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
}

function Read-Database([string]$Url, [string]$Username, [string]$Password, [string]$Sql) {
    $uri = [Uri]$Url.Replace('jdbc:', '')
    if ($uri.Host -ne '127.0.0.1' -or $uri.Port -ne 5433) { throw 'Unexpected database target' }
    if (-not $Username) {
        $auth = $uri.UserInfo.Split(':', 2)
        $Username = [Uri]::UnescapeDataString($auth[0])
        $Password = [Uri]::UnescapeDataString($auth[1])
    }
    $savedPassword = $env:PGPASSWORD
    $savedOptions = $env:PGOPTIONS
    try {
        $env:PGPASSWORD = $Password
        $env:PGOPTIONS = '-c statement_timeout=10000 -c lock_timeout=1000 -c default_transaction_read_only=on'
        $raw = & (Join-Path $PostgresBin 'psql.exe') -X -q -A -t -v ON_ERROR_STOP=1 `
            -h $uri.Host -p $uri.Port -U $Username -d $uri.AbsolutePath.Trim('/') -c $Sql 2>$null
        if ($LASTEXITCODE -ne 0) { return @{ status = 'QUERY_FAILED' } }
        return ($raw -join '') | ConvertFrom-Json
    } finally {
        $env:PGPASSWORD = $savedPassword
        $env:PGOPTIONS = $savedOptions
    }
}

$inventorySql = @'
SELECT json_build_object(
 'version',current_setting('server_version'),'database',current_database(),
 'settings',(SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN
   ('max_connections','reserved_connections','superuser_reserved_connections','shared_buffers',
    'work_mem','effective_cache_size','shared_preload_libraries','track_io_timing')),
 'bytes',pg_database_size(current_database()),
 'tables',(SELECT json_agg(row_to_json(t)) FROM (
    SELECT relname,n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_del,
           seq_scan,seq_tup_read,idx_scan,last_autovacuum,last_autoanalyze,
           pg_total_relation_size(relid) AS bytes
    FROM pg_stat_user_tables ORDER BY relname) t),
 'indexes',(SELECT json_agg(row_to_json(i)) FROM (
    SELECT s.relname,s.indexrelname,s.idx_scan,p.indisvalid,pg_get_indexdef(p.indexrelid) AS definition
    FROM pg_stat_user_indexes s JOIN pg_index p ON p.indexrelid=s.indexrelid
    ORDER BY s.relname,s.indexrelname) i),
 'activity',(SELECT json_agg(row_to_json(a)) FROM (
    SELECT datname,state,wait_event_type,count(*) FROM pg_stat_activity
    GROUP BY datname,state,wait_event_type) a),
 'locksWaiting',(SELECT count(*) FROM pg_locks WHERE NOT granted),
 'longTransactions',(SELECT count(*) FROM pg_stat_activity
    WHERE datname=current_database() AND xact_start<now()-interval '30 seconds'),
 'statementsEnabled',EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements')
);
'@
$databases = [ordered]@{}
foreach ($scope in @('control','crawler','capture')) {
    if ($SkipDatabaseInventory) { break }
    $url = switch ($scope) { control { $values.DB_URL } crawler { $values.CRAWLER_POSTGRES_URL } capture { $values.CAPTURE_DATABASE_URL } }
    $username = if ($scope -eq 'control') { $values.DB_USERNAME } else { $null }
    $password = if ($scope -eq 'control') { $values.DB_PASSWORD } else { $null }
    $databases[$scope] = Read-Database $url $username $password $inventorySql
}
$plans = @{}
if ($QueryPlans) {
    $sampleSql = "SELECT to_json(aggregate_id) FROM inbox_messages WHERE aggregate_type='SCAN' AND message_type='SCAN_REQUESTED' ORDER BY received_at DESC LIMIT 1"
    $scan = Read-Database $values.CRAWLER_POSTGRES_URL $null $null $sampleSql
    if ([string]$scan -notmatch '^[a-f0-9-]{36}$') { throw 'No valid representative scan for read-only plans' }
    foreach ($variant in @('baseline','candidate')) {
        $predicate = if ($variant -eq 'candidate') { "aggregate_type='SCAN' AND " } else { '' }
        $sql = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT correlation_id FROM inbox_messages WHERE ${predicate}aggregate_id='$scan' AND message_type='SCAN_REQUESTED' ORDER BY received_at,message_id LIMIT 1"
        $plans[$variant] = @(1..5 | ForEach-Object { Read-Database $values.CRAWLER_POSTGRES_URL $null $null $sql })
    }
    $plans.nonScanRequests = Read-Database $values.CRAWLER_POSTGRES_URL $null $null "SELECT to_json(count(*)) FROM inbox_messages WHERE message_type='SCAN_REQUESTED' AND aggregate_type<>'SCAN'"
}
$health = @{}
foreach ($port in @(8080,8081,8082)) {
    $path = if ($port -eq 8080) { 'actuator/health' } else { 'health/ready' }
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/$path" -TimeoutSec 5
        $health[[string]$port] = @{ status = $response.StatusCode; elapsedMs = $timer.Elapsed.TotalMilliseconds }
    } catch { $health[[string]$port] = @{ status = 'FAILED' } }
}
$safeConfig = @{}
foreach ($key in $values.Keys) {
    if ($key -match '^WEBLENS_(HIKARI_|TOMCAT_|SCAN_REPORT_)|^CRAWLER_(WORKERS|HOST_CONCURRENCY|GLOBAL_CONCURRENCY)|^CAPTURE_(CONCURRENCY|SITE_CLONE_CONCURRENCY)$') {
        $safeConfig[$key] = $values[$key]
    }
}
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_ComputerSystem
$artifacts = @{}
foreach ($item in @('backend\weblens-backend.jar','crawler\weblens-crawler.exe','capture-worker\dist\index.js')) {
    $path = Join-Path 'C:\WebLens\current' $item
    if (Test-Path -LiteralPath $path -PathType Leaf) { $artifacts[$item] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$metrics = @{}
foreach ($name in @('hikaricp.connections.active','hikaricp.connections.pending','hikaricp.connections.max','jvm.memory.used','tomcat.threads.busy')) {
    try {
        $metrics[$name] = Invoke-RestMethod "http://127.0.0.1:8080/actuator/metrics/$name" `
            -Headers @{ 'X-WebLens-Service-Token' = $values.WEBLENS_SERVICE_TOKEN } -TimeoutSec 3
    } catch { $metrics[$name] = @{ status = 'UNAVAILABLE' } }
}
$redis = @{ status = 'UNTESTED' }
$redisTimer = [Diagnostics.Stopwatch]::StartNew()
$tcp = [Net.Sockets.TcpClient]::new()
try {
    $port = if ($values.WEBLENS_REDIS_PORT) { [int]$values.WEBLENS_REDIS_PORT } else { 6379 }
    if (-not $tcp.ConnectAsync($values.WEBLENS_REDIS_HOST, $port).Wait(3000)) { throw 'REDIS_CONNECT_TIMEOUT' }
    $redis.tcpMs = $redisTimer.Elapsed.TotalMilliseconds
    $redis.phase = 'TCP_CONNECTED'
    $stream = $tcp.GetStream()
    $stream.ReadTimeout = $RedisReadTimeoutMs
    $stream.WriteTimeout = $RedisReadTimeoutMs
    if ($values.WEBLENS_REDIS_SSL -eq 'true') {
        $stream = [Net.Security.SslStream]::new($stream, $false)
        $stream.AuthenticateAsClient($values.WEBLENS_REDIS_HOST, $null, [Security.Authentication.SslProtocols]::Tls12, $true)
        $stream.ReadTimeout = $RedisReadTimeoutMs
        $stream.WriteTimeout = $RedisReadTimeoutMs
    }
    $redis.tlsMs = $redisTimer.Elapsed.TotalMilliseconds - $redis.tcpMs
    $redis.phase = 'TLS_CONNECTED'
    $commands = @()
    if ($values.WEBLENS_REDIS_PASSWORD) {
        $auth = @('AUTH')
        if ($values.WEBLENS_REDIS_USERNAME) { $auth += $values.WEBLENS_REDIS_USERNAME }
        $auth += $values.WEBLENS_REDIS_PASSWORD
        $commands += ,$auth
    }
    $commands += ,@('PING')
    foreach ($command in $commands) {
        $redis.phase = [string]$command[0]
        $wire = '*' + $command.Count + "`r`n"
        foreach ($part in $command) { $wire += '$' + [Text.Encoding]::UTF8.GetByteCount($part) + "`r`n" + $part + "`r`n" }
        $bytes = [Text.Encoding]::UTF8.GetBytes($wire)
        $stream.Write($bytes, 0, $bytes.Length)
        $buffer = New-Object byte[] 1024
        $length = $stream.Read($buffer, 0, $buffer.Length)
        $reply = [Text.Encoding]::UTF8.GetString($buffer, 0, $length)
        if ($reply -notmatch '^\+(OK|PONG)\r\n$') {
            $redis.replyBytes = $length
            $redis.replyKind = if ($reply.StartsWith('-')) { 'ERROR' } elseif ($length -eq 0) { 'EOF' } else { 'OTHER' }
            $redis.errorCode = if ($reply -match '^-(WRONGPASS|NOAUTH|LOADING|BUSY|ERR|OOM)\b') { $Matches[1] } else { 'UNKNOWN' }
            $redis.errorSignals = @(@('timeout','upstream','refused','password','authentication','not found','not running','unavailable','database','connection','dial','protocol','permission','deleted','moved','routing','disabled') | Where-Object { $reply.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
            $redis.errorSummary = Protect-RedisError $reply $values
            throw 'REDIS_PROTOCOL_FAILURE'
        }
    }
    $redis.status = 'PONG'
    $redis.totalMs = $redisTimer.Elapsed.TotalMilliseconds
} catch {
    $redis.status = 'FAILED'
    $redis.errorType = $_.Exception.GetType().Name
    $redis.innerErrorType = if ($_.Exception.InnerException) { $_.Exception.InnerException.GetType().Name } else { $null }
    $redis.totalMs = $redisTimer.Elapsed.TotalMilliseconds
} finally { $tcp.Dispose() }
$logSignals = @{}
foreach ($file in @('WebLensBackend.out.log','WebLensBackend.0.out.log')) {
    $path = Join-Path 'C:\ProgramData\WebLens\logs' $file
    if (Test-Path -LiteralPath $path) {
        $tail = Get-Content -LiteralPath $path -Tail 500
        foreach ($signal in @('RedisCommandTimeoutException','RedisConnectionFailureException','RedisConnectionException',
            'SSLHandshakeException','ConnectTimeoutException','UnknownHostException','WRONGPASS','NOAUTH','OutOfMemoryError')) {
            $logSignals[$signal] = [int]$logSignals[$signal] + @($tail | Select-String -SimpleMatch $signal).Count
        }
    }
}
[ordered]@{
    utc = [DateTime]::UtcNow.ToString('o'); machine = [Environment]::MachineName
    logicalProcessors = $cpu.NumberOfLogicalProcessors
    memoryBytes = $cpu.TotalPhysicalMemory; freeMemoryKiB = $os.FreePhysicalMemory
    disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace)
    services = @(Get-Service 'WebLens*' | Select-Object Name,@{Name='status';Expression={$_.Status.ToString()}})
    release = Get-Content -Raw -LiteralPath 'C:\WebLens\current\release.json' | ConvertFrom-Json
    config = $safeConfig; hashes = $artifacts; health = $health; metrics = $metrics; redis = $redis; logSignals = $logSignals; databases = $databases; plans = $plans
} | ConvertTo-Json -Depth 16 -Compress
