[CmdletBinding()]
param(
    [string] $OutputRoot = 'C:\ProgramData\WebLens\backups',
    [string] $EnvironmentFile = 'C:\ProgramData\WebLens\weblens.env',
    [string] $PostgresBin = 'C:\WebLens\runtime\postgresql17\bin'
)

$ErrorActionPreference = 'Stop'

function Read-EnvironmentFile([string] $Path) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -gt 0) { $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
    }
    return $values
}

function ConvertTo-Connection([string] $Url, [string] $Username, [string] $Password) {
    if ($Url -match '^jdbc:postgresql://(?<host>\[[^\]]+\]|[^:/?#]+)(:(?<port>\d+))?/(?<database>[^?]+)') {
        return [pscustomobject]@{
            host = $Matches.host.Trim('[', ']')
            port = if ($Matches.port) { [int]$Matches.port } else { 5432 }
            database = [Uri]::UnescapeDataString($Matches.database)
            username = $Username
            password = $Password
        }
    }
    $uri = [Uri]$Url
    $userInfo = @($uri.UserInfo.Split(':', 2))
    return [pscustomobject]@{
        host = $uri.Host
        port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
        database = [Uri]::UnescapeDataString($uri.AbsolutePath.Trim('/'))
        username = [Uri]::UnescapeDataString($userInfo[0])
        password = [Uri]::UnescapeDataString($userInfo[1])
    }
}

function Backup-Database([string] $Name, $Connection, [string] $Directory, [string] $DumpTool, [string] $RestoreTool) {
    $dumpPath = Join-Path $Directory "$Name.dump"
    $tocPath = Join-Path $Directory "$Name-toc.txt"
    $previousPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $Connection.password, 'Process')
        & $DumpTool -h $Connection.host -p $Connection.port -U $Connection.username -d $Connection.database `
            --format=custom --compress=6 --no-owner --no-acl --file=$dumpPath
        if ($LASTEXITCODE -ne 0) { throw "pg_dump failed for $Name" }
        $toc = & $RestoreTool --list $dumpPath
        if ($LASTEXITCODE -ne 0 -or @($toc).Count -eq 0) { throw "pg_restore --list failed for $Name" }
        [IO.File]::WriteAllText($tocPath, ([string]::Join("`n", @($toc)) + "`n"), [Text.UTF8Encoding]::new($false))
        $file = Get-Item -LiteralPath $dumpPath
        return [pscustomobject]@{
            database = $Name
            bytes = $file.Length
            sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $dumpPath).Hash.ToLowerInvariant()
            tocEntries = @($toc | Where-Object { $_ -and -not $_.StartsWith(';') }).Count
        }
    } finally {
        [Environment]::SetEnvironmentVariable('PGPASSWORD', $previousPassword, 'Process')
    }
}

if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) { throw 'Production environment file is missing' }
$dumpTool = Join-Path $PostgresBin 'pg_dump.exe'
$restoreTool = Join-Path $PostgresBin 'pg_restore.exe'
if (-not (Test-Path -LiteralPath $dumpTool -PathType Leaf) -or
    -not (Test-Path -LiteralPath $restoreTool -PathType Leaf)) {
    throw 'PostgreSQL backup tools are missing'
}

$environment = Read-EnvironmentFile $EnvironmentFile
$connections = [ordered]@{
    weblens = ConvertTo-Connection $environment.DB_URL $environment.DB_USERNAME $environment.DB_PASSWORD
    weblens_crawler = ConvertTo-Connection $environment.CRAWLER_POSTGRES_URL $null $null
    weblens_capture = ConvertTo-Connection $environment.CAPTURE_DATABASE_URL $null $null
}
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$directory = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) "performance-preflight-$timestamp"
if (Test-Path -LiteralPath $directory) { throw "Backup directory already exists: $directory" }
[IO.Directory]::CreateDirectory($directory) | Out-Null

$results = @()
foreach ($entry in $connections.GetEnumerator()) {
    $results += Backup-Database $entry.Key $entry.Value $directory $dumpTool $restoreTool
}

$releaseCommit = $null
$releaseMetadata = 'C:\WebLens\current\release.json'
if (Test-Path -LiteralPath $releaseMetadata -PathType Leaf) {
    try { $releaseCommit = (Get-Content -Raw -LiteralPath $releaseMetadata | ConvertFrom-Json).commit } catch {}
}
$manifest = [ordered]@{
    schemaVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    releaseCommit = $releaseCommit
    databases = $results
    restoreEvidence = 'Run pg_restore into isolated databases; this backup only validates archive TOCs.'
    excludedStores = @('ClickHouse Cloud', 'Cloudflare R2')
}
$manifestPath = Join-Path $directory 'manifest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
    outcome = 'COMPLETED'
    directory = $directory
    manifest = $manifestPath
    databases = @($results | ForEach-Object { [pscustomobject]@{ database = $_.database; bytes = $_.bytes; sha256 = $_.sha256 } })
} | ConvertTo-Json -Depth 5 -Compress
