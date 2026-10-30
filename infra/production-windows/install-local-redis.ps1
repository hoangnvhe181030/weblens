[CmdletBinding()]
param([ValidateSet('install','activate','verify','rollback','selftest')][string]$Action = 'verify')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '8.2.10'
$archiveHash = '92d9bdde87ed52bf859a677e5197d8ac855ba78d9940d457881723ae960df429'
$runtimeRoot = "C:\WebLens\runtime\redis-$version"
$runtime = Join-Path $runtimeRoot "Redis-$version-Windows-x64-cygwin"
$root = 'C:\ProgramData\WebLens\redis-local'
$data = Join-Path $root 'data'
$environment = 'C:\ProgramData\WebLens\weblens.env'
$backup = Join-Path $root 'original-weblens.env'
$manifest = Join-Path $root 'deployment.json'
$wrapper = 'C:\ProgramData\WebLens\services\WebLensRedis.exe'
$xml = [IO.Path]::ChangeExtension($wrapper, '.xml')
$utf8 = [Text.UTF8Encoding]::new($false)

function Secret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
function Digest([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Protect([string]$Path, [string]$ServicePermission = '') {
    $inherit = if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) { '(OI)(CI)' } else { '' }
    $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $grants = @("SYSTEM:${inherit}F", "BUILTIN\Administrators:${inherit}F", "*${operatorSid}:${inherit}F")
    if ($ServicePermission) { $grants += "NT SERVICE\WebLensRedis:${inherit}$ServicePermission" }
    & icacls.exe $Path '/inheritance:r' '/grant:r' $grants | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Redis ACL configuration failed' }
}
function Invoke-RedisCommand([string[]]$Arguments, [switch]$Application) {
    $saved = $env:REDISCLI_AUTH
    try {
        if ($Application) {
            $settings = @{}
            foreach ($line in [IO.File]::ReadAllLines($environment)) {
                if ($line -match '^([^#=]+)=(.*)$') { $settings[$Matches[1]] = $Matches[2] }
            }
            $env:REDISCLI_AUTH = $settings.WEBLENS_REDIS_PASSWORD
            $user = 'weblens'
        } else {
            $env:REDISCLI_AUTH = [IO.File]::ReadAllText((Join-Path $root 'admin-secret')).Trim()
            $user = 'default'
        }
        $result = & (Join-Path $runtime 'redis-cli.exe') --raw -h 127.0.0.1 -p 6379 --user $user @Arguments 2>$null
        if ($LASTEXITCODE -ne 0 -or ($result -join "`n") -match '^(ERR|NOAUTH|WRONGPASS|NOPERM|MISCONF|OOM)') {
            throw 'Redis command failed (details intentionally omitted)'
        }
        return (($result | Where-Object { $_ -notmatch '^Warning:' }) -join "`n").Trim()
    } finally { $env:REDISCLI_AUTH = $saved }
}
function Wait-Redis {
    for ($i = 0; $i -lt 30; $i++) {
        try { if ((Invoke-RedisCommand @('PING')) -eq 'PONG') { return } } catch {}
        Start-Sleep -Seconds 1
    }
    throw 'Redis did not become healthy'
}
function Configure-DataMount {
    # Avoid POSIX SID translation for the dedicated data mount; Windows ACLs still enforce access.
    $etc = Join-Path $runtimeRoot 'etc'
    if (-not (Test-Path $etc)) { New-Item -ItemType Directory -Path $etc | Out-Null }
    $fstab = Join-Path $etc 'fstab'
    $oldEntry = "C:/ProgramData/WebLens/redis-local/data /weblens-data ntfs binary,noacl,posix=0 0 0`n"
    # Relative AOF paths may normalize through /cygdrive; retain NTFS enforcement there too.
    $entry = "none /cygdrive cygdrive binary,noacl,posix=0 0 0`n" + $oldEntry
    if ((Test-Path $fstab) -and [IO.File]::ReadAllText($fstab) -notin @($entry, $oldEntry)) { throw 'Cygwin mount configuration already differs' }
    [IO.File]::WriteAllText($fstab, $entry, $utf8)
    Protect $etc 'RX'
}
function Stop-Backend {
    Stop-Service WebLensBackend
    Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object {
        $_.ExecutablePath -eq 'C:\WebLens\runtime\jre21\bin\java.exe' -and
        $_.CommandLine -match '(?i)(^|\s)-jar\s+weblens-backend\.jar(\s|$)'
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { throw 'Backend port still occupied' }
}
function Wait-Backend {
    for ($i = 0; $i -lt 90; $i++) {
        try {
            $raw = & curl.exe --silent --noproxy '*' --max-time 3 --write-out '|%{http_code}' http://127.0.0.1:8080/actuator/health 2>$null
            if ($LASTEXITCODE -eq 0 -and ($raw -join '') -match '^(?<body>.*)\|200$' -and
                ($Matches.body | ConvertFrom-Json).status -eq 'UP') { return }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw 'Backend health failed'
}
function Verify {
    Wait-Redis
    $listeners = @(Get-NetTCPConnection -LocalPort 6379 -State Listen)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { throw 'Redis must listen exclusively on IPv4 loopback' }
    $saved = $env:REDISCLI_AUTH
    try {
        $env:REDISCLI_AUTH = $null
        $unauth = & (Join-Path $runtime 'redis-cli.exe') --raw -h 127.0.0.1 -p 6379 PING 2>$null
        if (($unauth -join '') -notmatch 'NOAUTH') { throw 'Unauthenticated Redis was not rejected' }
    } finally { $env:REDISCLI_AUTH = $saved }
    $key = 'weblens:auth:v1:session:deployment-probe-' + [guid]::NewGuid().ToString('N')
    $expires = [DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeMilliseconds().ToString()
    try {
        if ((Invoke-RedisCommand @('SET', $key, 'probe-owner:old', 'NX', 'PXAT', $expires) -Application) -ne 'OK') { throw 'SET PXAT failed' }
        $lua = "if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'PXAT',ARGV[3]); return 1"
        if ((Invoke-RedisCommand @('EVAL', $lua, '1', $key, 'probe-owner:old', 'probe-owner:new', $expires) -Application) -ne '1') { throw 'Refresh CAS failed' }
        if ((Invoke-RedisCommand @('EVAL', $lua, '1', $key, 'probe-owner:old', 'probe-owner:replay', $expires) -Application) -ne '0') { throw 'Refresh replay accepted' }
        Invoke-RedisCommand @('SAVE') | Out-Null
        # Flush the AOF before exercising service stop/start, without touching other keys.
        Start-Sleep -Seconds 2
        Stop-Service WebLensRedis
        Start-Service WebLensRedis
        Wait-Redis
        if ((Invoke-RedisCommand @('GET', $key) -Application) -ne 'probe-owner:new') { throw 'Redis restart lost the persistent probe' }
        $ttl = [int64](Invoke-RedisCommand @('PTTL', $key))
        if ($ttl -le 0 -or $ttl -gt 300000) { throw 'Restart changed session expiry' }
        $info = Invoke-RedisCommand @('INFO', 'persistence')
        if ($info -notmatch 'aof_enabled:1' -or $info -notmatch 'aof_last_write_status:ok' -or $info -notmatch 'rdb_last_bgsave_status:ok') {
            throw 'Persistence health failed'
        }
        $serviceSid = ([Security.Principal.NTAccount]::new('NT SERVICE\WebLensRedis')).Translate([Security.Principal.SecurityIdentifier]).Value
        $allowed = @('S-1-5-18','S-1-5-32-544',$serviceSid,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        foreach ($file in Get-ChildItem -LiteralPath $data -File -Recurse) {
            foreach ($ace in (Get-Acl -LiteralPath $file.FullName).Access) {
                if ($ace.AccessControlType -ne 'Allow' -or $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) {
                    throw 'Redis persistence file ACL is not restricted to the service and administrators'
                }
            }
        }
    } finally { Invoke-RedisCommand @('DEL', $key) | Out-Null }
    [pscustomobject]@{ status='PASS'; redisVersion=$version; loopbackOnly=$true; unauthenticatedRejected=$true;
        refreshCas=$true; replayRejected=$true; restartPersistence=$true; expiryPreserved=$true; persistenceAclRestricted=$true }
}

if ($Action -eq 'selftest') {
    $secret = Secret
    if ($secret -notmatch '^[a-f0-9]{64}$' -or (Digest 'abc') -ne 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') { throw 'Selftest failed' }
    $fixture = New-TemporaryFile
    try {
        Protect $fixture.FullName
        if (@((Get-Acl $fixture.FullName).Access).Count -lt 2) { throw 'File ACL selftest failed' }
        Get-FileHash $fixture.FullName | Out-Null
    } finally { Remove-Item -LiteralPath $fixture.FullName }
    'Selftest PASS'; return
}
if ($env:COMPUTERNAME -ne 'WIN-D1G2GS3O7J7') { throw 'This deployment is pinned to the inspected WebLens VPS' }
$mutex = [Threading.Mutex]::new($false, 'Global\WebLensDeployment')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); throw 'Another deployment is running' }
$poll = Get-ScheduledTask -TaskName WebLensDeployPoll -ErrorAction SilentlyContinue
$pollEnabled = $poll -and $poll.State.ToString() -ne 'Disabled'
try {
    if ($pollEnabled) { Disable-ScheduledTask -TaskName WebLensDeployPoll | Out-Null }
    if ($Action -eq 'rollback') {
        $record = Get-Content -Raw $manifest | ConvertFrom-Json
        if ((Get-FileHash $environment -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.environmentSha256) { throw 'Environment changed; rollback refused' }
        if ((Get-FileHash $backup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.backupSha256) { throw 'Backup checksum mismatch' }
        Stop-Backend
        Copy-Item -LiteralPath $backup -Destination $environment -Force
        & sc.exe config WebLensBackend depend= WebLensPostgres | Out-Null
        Start-Service WebLensBackend
        Write-Warning 'Previous shared Redis restored; its provider sleep fault may still prevent authentication. Local data/service retained.'
        return
    }
    if ($Action -eq 'verify') {
        $dependent = @((Get-Service WebLensRedis).DependentServices | Where-Object { $_.Status -ne 'Stopped' })
        if (@($dependent | Where-Object Name -ne 'WebLensBackend').Count) { throw 'Unexpected Redis dependent service; maintenance refused' }
        $restartBackend = @($dependent | Where-Object Name -eq 'WebLensBackend').Count -eq 1
        if ($restartBackend) { Stop-Backend }
        try { Verify | ConvertTo-Json -Compress }
        finally {
            if ((Get-Service WebLensRedis).Status -ne 'Running') {
                Start-Service WebLensRedis
                Wait-Redis
            }
            if ($restartBackend) { Start-Service WebLensBackend }
            Wait-Backend
        }
        return
    }
    if ($Action -eq 'activate') {
        if (-not (Get-Service WebLensRedis -ErrorAction SilentlyContinue) -or (Test-Path $manifest) -or
            (Get-FileHash $backup).Hash -ne (Get-FileHash $environment).Hash) { throw 'Activation state changed; inspect before proceeding' }
        Configure-DataMount
        $configPath = Join-Path $root 'redis.conf'
        $configLines = @([IO.File]::ReadAllLines($configPath) | ForEach-Object {
            if ($_ -match '^dir ') { 'dir /weblens-data' } else { $_ }
        })
        [IO.File]::WriteAllLines($configPath, $configLines, $utf8)
        Start-Service WebLensRedis
        Wait-Redis
        $app = Secret
        $hash = Digest $app
        Invoke-RedisCommand @('ACL','SETUSER','weblens','resetpass', ('#' + $hash)) | Out-Null
        $aclPath = Join-Path $root 'users.acl'
        $acl = @([IO.File]::ReadAllLines($aclPath) | ForEach-Object {
            if ($_ -match '^user weblens ') { $_ -replace '#[a-f0-9]{64}', ('#' + $hash) } else { $_ }
        })
        [IO.File]::WriteAllLines($aclPath, $acl, $utf8)
    } else {
    if (Get-Service WebLensRedis -ErrorAction SilentlyContinue) { throw 'Redis service already exists; use verify, do not overwrite data/config' }
    if (Test-Path $root) {
        Protect $backup
        # Resume only the download/extraction stage, never a configured or activated registry.
        if (-not (Test-Path $backup) -or (Test-Path $manifest) -or (Test-Path (Join-Path $root 'redis.conf')) -or
            (Get-FileHash $backup).Hash -ne (Get-FileHash $environment).Hash -or @(Get-ChildItem $data -Force).Count -ne 0) {
            throw 'Existing Redis deployment is not an unactivated extraction stage'
        }
    } else {
        New-Item -ItemType Directory -Path $root, $data | Out-Null
        Protect $root
        Copy-Item -LiteralPath $environment -Destination $backup
        Protect $backup
    }
    if (Get-NetTCPConnection -LocalPort 6379 -State Listen -ErrorAction SilentlyContinue) { throw 'Redis port occupied' }
    $archive = "C:\ProgramData\WebLens\downloads\Redis-$version-Windows-x64-cygwin.zip"
    if (-not (Test-Path $archive)) {
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/redis-windows/redis-windows/releases/download/$version/Redis-$version-Windows-x64-cygwin.zip" -OutFile $archive
    }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) { throw 'Redis archive checksum mismatch' }
    if (-not (Test-Path $runtimeRoot)) { Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot }
    if (-not (Test-Path (Join-Path $runtime 'redis-server.exe'))) { throw 'Unexpected Redis archive layout' }
    Configure-DataMount
    $admin = Secret
    $app = Secret
    [IO.File]::WriteAllText((Join-Path $root 'admin-secret'), $admin, $utf8)
    [IO.File]::WriteAllLines((Join-Path $root 'users.acl'), @(
        ('user default on #' + (Digest $admin) + ' ~* &* +@all'),
        ('user weblens on #' + (Digest $app) + ' ~weblens:auth:v1:session:* -@all +ping +hello +select +get +set +del +eval +evalsha +script|load +info +client|setname +client|setinfo +client|getname +quit')
    ), $utf8)
    [IO.File]::WriteAllLines((Join-Path $root 'redis.conf'), @(
        'bind 127.0.0.1', 'protected-mode yes', 'port 6379', 'daemonize no', 'timeout 300',
        'tcp-keepalive 60', 'databases 1', 'maxclients 128', 'maxmemory 128mb', 'maxmemory-policy noeviction',
        'dir /weblens-data', 'logfile ""', 'loglevel notice',
        'aclfile /cygdrive/c/ProgramData/WebLens/redis-local/users.acl',
        'appendonly yes', 'appendfsync everysec', 'no-appendfsync-on-rewrite no',
        'auto-aof-rewrite-percentage 100', 'auto-aof-rewrite-min-size 16mb',
        'save 900 1', 'save 300 10', 'stop-writes-on-bgsave-error yes'
    ), $utf8)
    Copy-Item 'C:\WebLens\runtime\winsw.exe' $wrapper
    $logs = Join-Path $root 'logs'
    New-Item -ItemType Directory -Path $logs | Out-Null
    [IO.File]::WriteAllText($xml, @"
<service>
  <id>WebLensRedis</id><name>WebLens Local Redis</name>
  <description>Loopback-only persistent JWT session registry; community Windows build for this personal project</description>
  <executable>$runtime\redis-server.exe</executable>
  <arguments>/cygdrive/c/ProgramData/WebLens/redis-local/redis.conf</arguments>
  <workingdirectory>$runtime</workingdirectory><startmode>Automatic</startmode>
  <stoptimeout>30sec</stoptimeout><onfailure action="restart" delay="10 sec" />
  <logpath>C:\ProgramData\WebLens\redis-local\logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>1024</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@, $utf8)
    & $wrapper install | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Redis service install failed' }
    & sc.exe config WebLensRedis obj= 'NT SERVICE\WebLensRedis' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Redis service account failed' }
    Protect $runtime 'RX'
    foreach ($path in @('C:\ProgramData\WebLens','C:\ProgramData\WebLens\services', $wrapper)) {
        & icacls.exe $path '/grant' 'NT SERVICE\WebLensRedis:RX' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Redis service traversal permission failed' }
    }
    & icacls.exe $xml '/grant' 'NT SERVICE\WebLensRedis:R' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Redis wrapper configuration permission failed' }
    Protect $root 'RX'
    # Cygwin persistence also sets POSIX file ACLs; restrict Full Control to its data only.
    Protect $data 'F'
    Protect $logs 'M'
    Protect (Join-Path $root 'admin-secret')
    Protect $backup
    Start-Service WebLensRedis
    Wait-Redis
    }
    $lines = @([IO.File]::ReadAllLines($environment) | Where-Object {
        $_ -notmatch '^WEBLENS_REDIS_(HOST|PORT|USERNAME|PASSWORD|SSL)=' -and $_ -notmatch '^SPRING_DATA_REDIS_(CONNECT_TIMEOUT|TIMEOUT)='
    })
    $lines += @('WEBLENS_REDIS_HOST=127.0.0.1','WEBLENS_REDIS_PORT=6379','WEBLENS_REDIS_USERNAME=weblens',
        ('WEBLENS_REDIS_PASSWORD=' + $app),'WEBLENS_REDIS_SSL=false','SPRING_DATA_REDIS_CONNECT_TIMEOUT=2s','SPRING_DATA_REDIS_TIMEOUT=2s')
    Stop-Backend
    try {
        [IO.File]::WriteAllLines($environment, $lines, $utf8)
        & sc.exe config WebLensBackend depend= WebLensPostgres/WebLensRedis | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Backend dependency update failed' }
        Verify | ConvertTo-Json -Compress
        Start-Service WebLensBackend
        Wait-Backend
        $record = [ordered]@{ status='HEALTHY_PENDING_AUTH_SMOKE'; installedAtUtc=[DateTime]::UtcNow.ToString('o'); redisVersion=$version;
            archiveSha256=$archiveHash; environmentSha256=(Get-FileHash $environment -Algorithm SHA256).Hash.ToLowerInvariant();
            backupSha256=(Get-FileHash $backup -Algorithm SHA256).Hash.ToLowerInvariant(); sharedRedisDataChanged=$false;
            persistence='AOF everysec + RDB'; support='Community Windows port, personal-project experiment; not vendor-supported production' }
        [IO.File]::WriteAllText($manifest, ($record | ConvertTo-Json), $utf8)
        $record | ConvertTo-Json -Compress
    } catch {
        Stop-Backend
        Copy-Item -LiteralPath $backup -Destination $environment -Force
        & sc.exe config WebLensBackend depend= WebLensPostgres | Out-Null
        Start-Service WebLensBackend
        throw 'Local Redis activation failed; environment restored, local service/data retained for inspection'
    }
} finally {
    if ($pollEnabled) { Enable-ScheduledTask -TaskName WebLensDeployPoll | Out-Null }
    $admin=$null; $app=$null; $lines=$null
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
