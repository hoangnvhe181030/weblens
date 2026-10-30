# Read-only diagnostic; no DDL, backup, service changes or acceptance of load.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:COMPUTERNAME -ne 'WIN-D1G2GS3O7J7') { throw 'Unexpected production host' }
$psqlTool = 'C:\WebLens\runtime\postgresql17\bin\psql.exe'
$values = @{}
foreach ($line in [IO.File]::ReadAllLines('C:\ProgramData\WebLens\weblens.env')) {
    if ($line -match '^([^#=]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
}

function Read-IndexPreflight([string] $Url, [string] $UserName, [string] $Password, [string] $Query) {
    $uri = [Uri]$Url.Replace('jdbc:', '')
    if (-not $UserName) {
        $auth = $uri.UserInfo.Split(':', 2)
        $UserName = [Uri]::UnescapeDataString($auth[0])
        $Password = [Uri]::UnescapeDataString($auth[1])
    }
    if ($uri.Host -ne '127.0.0.1' -or $uri.Port -ne 5433 -or
        $uri.AbsolutePath.Trim('/') -notin @('weblens','weblens_crawler','weblens_capture')) {
        throw 'Unexpected PostgreSQL connection target'
    }
    $savedPassword = $env:PGPASSWORD
    $savedOptions = $env:PGOPTIONS
    try {
        $env:PGPASSWORD = $Password
        $env:PGOPTIONS = '-c statement_timeout=2000 -c lock_timeout=500 -c default_transaction_read_only=on'
        $ErrorActionPreference = 'Continue'
        $raw = & $psqlTool -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate `
            -h $uri.Host -p $uri.Port -U $UserName -d $uri.AbsolutePath.Trim('/') -c $Query 2>&1
        if ($LASTEXITCODE -ne 0) {
            $state = 'unknown'
            foreach ($row in $raw) { if ([string]$row -match '(?:ERROR|FATAL):\s*([0-9A-Z]{5})\b') { $state = $Matches[1]; break } }
            throw "Read-only preflight failed; SQLSTATE=$state"
        }
        ($raw -join '') | ConvertFrom-Json
    } finally {
        $env:PGPASSWORD = $savedPassword
        $env:PGOPTIONS = $savedOptions
    }
}

function Read-PreflightScope([string] $Scope, [string] $Query, [string] $Url = $values.CRAWLER_POSTGRES_URL, [string] $UserName, [string] $Password) {
    try { [pscustomobject]@{ scope = $Scope; status = 'AVAILABLE'; data = Read-IndexPreflight $Url $UserName $Password $Query } }
    catch {
        if ($_.Exception.Message -notmatch '^Read-only preflight failed; SQLSTATE=([0-9A-Z]{5}|unknown)$') { throw }
        [pscustomobject]@{ scope = $Scope; status = 'UNVERIFIED'; sqlstate = $Matches[1]; data = $null }
    }
}
$queries = [ordered]@{
 version = "SELECT json_build_object('version',current_setting('server_version'),'database',current_database(),'user',current_user)"
 databaseBytes = "SELECT to_json(pg_database_size(current_database()))"
 tables = @'
SELECT json_agg(row_to_json(r)) FROM (
   SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.reltuples,
     pg_relation_size(c.oid) AS heap_bytes,pg_total_relation_size(c.oid) AS total_bytes,
     s.n_tup_ins,s.n_tup_upd,s.n_tup_del,s.n_dead_tup
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
   WHERE n.nspname='public' AND (c.relname='outbox_events' OR c.oid IN (SELECT relid FROM pg_partition_tree('public.scan_pages')))
   ORDER BY c.relname) r;
'@
 indexes = @'
SELECT json_agg(row_to_json(r)) FROM (
   SELECT i.indexrelid::regclass::text AS name,i.indisvalid,i.indisready,i.indislive,
    pg_get_indexdef(i.indexrelid) AS definition,pg_get_expr(i.indpred,i.indrelid) AS predicate
   FROM pg_index i WHERE i.indrelid='public.outbox_events'::regclass OR
    i.indrelid IN (SELECT relid FROM pg_partition_tree('public.scan_pages')) ORDER BY i.indexrelid) r;
'@
 partitions = "SELECT json_agg(row_to_json(r)) FROM (SELECT relid::regclass::text AS name,parentrelid::regclass::text AS parent,isleaf,level FROM pg_partition_tree('public.scan_pages')) r"
 history = 'SELECT json_agg(row_to_json(r)) FROM (SELECT version,checksum_sha256 FROM crawler_schema_history ORDER BY version) r'
 constraints = @'
SELECT json_agg(row_to_json(r)) FROM (
    SELECT conname,conrelid::regclass::text AS relation,convalidated,md5(pg_get_constraintdef(oid)) AS definition_md5
    FROM pg_constraint WHERE conrelid='public.outbox_events'::regclass OR
    conrelid IN (SELECT relid FROM pg_partition_tree('public.scan_pages')) ORDER BY conrelid,conname) r;
'@
 activity = @'
SELECT json_build_object(
 'active',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle'),
 'longTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND xact_start<now()-interval '30 seconds'),
 'indexBuilds',(SELECT count(*) FROM pg_stat_progress_create_index),
 'locksWaiting',(SELECT count(*) FROM pg_locks WHERE NOT granted)
);
'@
}
$result = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); scope = 'READ_ONLY_NO_DDL' }
$result.catalog = @(foreach ($entry in $queries.GetEnumerator()) { Read-PreflightScope $entry.Key $entry.Value })
$result.persistingPlan = Read-PreflightScope 'persistingPlan' "EXPLAIN (FORMAT JSON) SELECT EXISTS(SELECT 1 FROM scan_pages WHERE status='PERSISTING')"
$result.deadPlan = Read-PreflightScope 'deadPlan' "EXPLAIN (FORMAT JSON) SELECT EXISTS(SELECT 1 FROM outbox_events WHERE status='DEAD')"
$statsSql = @'
SELECT json_build_object('database',current_database(),'bytes',pg_database_size(current_database()),
 'stats',(SELECT row_to_json(d) FROM (SELECT xact_commit,xact_rollback,temp_bytes,deadlocks,stats_reset FROM pg_stat_database WHERE datname=current_database()) d));
'@
$result.databases = @(
    Read-PreflightScope 'control' $statsSql $values.DB_URL $values.DB_USERNAME $values.DB_PASSWORD
    Read-PreflightScope 'crawler' $statsSql $values.CRAWLER_POSTGRES_URL
    Read-PreflightScope 'capture' $statsSql $values.CAPTURE_DATABASE_URL
)
$result.backups = @(Get-ChildItem 'C:\ProgramData\WebLens\backups' -Directory | Sort-Object LastWriteTime | Select-Object -Last 3 | ForEach-Object {
    $manifestFile = Join-Path $_.FullName 'manifest.json'
    if (Test-Path -LiteralPath $manifestFile -PathType Leaf) {
        $manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json
        [pscustomobject]@{ directory = $_.FullName; createdAt = $manifest.createdAtUtc; databases = $manifest.databases; restoreEvidence = $manifest.restoreEvidence }
    }
})
$result.backupAcl = @((Get-Acl 'C:\ProgramData\WebLens\backups').Access | Select-Object IdentityReference,FileSystemRights,AccessControlType,IsInherited)
$result | ConvertTo-Json -Depth 35 -Compress
