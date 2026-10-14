# Fresh private backup only; no database DDL or release/service changes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:COMPUTERNAME -ne 'WIN-D1G2GS3O7J7') { throw 'Unexpected production host' }
$tool = 'C:\ProgramData\WebLens\performance-fixture\backup-production-postgres-windows.ps1'
if ((Get-FileHash -LiteralPath $tool).Hash.ToLowerInvariant() -ne '1a13355c67577541ad66a9591e8adfd910998ebd513adcb456cc4ecb951175cb') { throw 'Backup tool checksum mismatch' }
$mutex = [Threading.Mutex]::new($false, 'Global\WebLensDeployment')
$held = $false
try {
    $held = $mutex.WaitOne(0)
    if (-not $held) { throw 'Deployment mutex busy' }
    foreach ($port in 8080,8081,8082) {
        $path = if ($port -eq 8080) { '/actuator/health' } else { '/health/ready' }
        $raw = & curl.exe --fail --silent --noproxy '*' --max-time 5 "http://127.0.0.1:$port$path" 2>$null
        if ($LASTEXITCODE -ne 0 -or (($raw -join '') | ConvertFrom-Json).status -ne 'UP') { throw 'Backup health preflight failed' }
    }
    $os = Get-CimInstance Win32_OperatingSystem
    $free = (Get-PSDrive C).Free
    if ([long]$os.FreePhysicalMemory * 1024 -lt 1.5GB -or $free -lt 8GB) { throw 'Backup resource preflight failed' }
    $root = 'C:\ProgramData\WebLens\backups\recovery-index-20261009-' + [guid]::NewGuid().ToString('N')
    if (Test-Path -LiteralPath $root) { throw 'Private backup root already exists' }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    & icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Private backup ACL setup failed' }
    $allowed = @('S-1-5-18','S-1-5-32-544')
    foreach ($entry in (Get-Acl -LiteralPath $root).Access) {
        if ($entry.AccessControlType -ne 'Allow' -or $entry.IsInherited -or
            $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Unexpected private backup ACL' }
    }
    [pscustomobject]@{ phase='BACKUP_STARTED'; host=$env:COMPUTERNAME; parentPid=$PID; privateRoot=$root;
        minimumFreeDiskBytes=5GB; archiveBudgetBytes=2GB; preflightFreeDiskBytes=$free } | ConvertTo-Json -Compress
    & $tool -OutputRoot $root
    $after = (Get-PSDrive C).Free
    if ($after -lt 5GB) { throw 'Post-backup disk guard failed; no DDL permitted' }
    [pscustomobject]@{phase='BACKUP_FINISHED';postFreeDiskBytes=$after;ddlExecuted=$false} | ConvertTo-Json -Compress
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
