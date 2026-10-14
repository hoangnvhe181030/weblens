[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('enable', 'status', 'disable')]
    [string] $Action,

    [string] $CaddyFile = 'C:\WebLens\current\infra\production-windows\Caddyfile',
    [string] $CaddyExe = 'C:\WebLens\runtime\caddy\caddy.exe',
    [string] $StateRoot = 'C:\ProgramData\WebLens\performance-fixture\runtime'
)

$ErrorActionPreference = 'Stop'
$serviceName = 'WebLensCaddy'
$beginMarker = '# WEBLENS_LOAD_HOSTS_BEGIN'
$endMarker = '# WEBLENS_LOAD_HOSTS_END'
$probeHost = 'phase5-probe.jobnext.top'
$healthUrl = "http://$probeHost/__weblens-load/__fixture/health"
$pageUrl = "http://$probeHost/__weblens-load/page/999"
$outsideUrl = "http://$probeHost/"

function Test-Config([string] $Path) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $validation = & $CaddyExe validate --config $Path --adapter caddyfile 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) { throw "Caddy validation failed: $validation" }
}

function Restart-Caddy {
    Restart-Service -Name $serviceName -Force
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
}

function Test-SyntheticHosts {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
        $page = Invoke-WebRequest -UseBasicParsing -Uri $pageUrl -TimeoutSec 5
        try {
            $outside = Invoke-WebRequest -UseBasicParsing -Uri $outsideUrl -TimeoutSec 5 -ErrorAction Stop
            $outsideStatus = [int]$outside.StatusCode
        } catch {
            $outsideStatus = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        }
        return $health.status -eq 'UP' -and $health.pageCount -eq 1000 -and
            $page.StatusCode -eq 200 -and $page.Content -match '<h1>Fixture page 999</h1>' -and
            $outsideStatus -eq 404
    } catch {
        return $false
    }
}

function Write-Status {
    $content = if (Test-Path -LiteralPath $CaddyFile -PathType Leaf) {
        [IO.File]::ReadAllText($CaddyFile)
    } else { '' }
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    [pscustomobject]@{
        enabled = $content.Contains($beginMarker) -and $content.Contains($endMarker)
        serviceRunning = $null -ne $service -and $service.Status -eq 'Running'
        syntheticHostsHealthy = Test-SyntheticHosts
        probeHost = $probeHost
    } | ConvertTo-Json -Compress
}

if ($Action -eq 'status') { Write-Status; exit 0 }
if (-not (Test-Path -LiteralPath $CaddyFile -PathType Leaf)) { throw "Caddyfile not found: $CaddyFile" }
if (-not (Test-Path -LiteralPath $CaddyExe -PathType Leaf)) { throw "Caddy executable not found: $CaddyExe" }

$original = [IO.File]::ReadAllText($CaddyFile)
$hasBegin = $original.Contains($beginMarker)
$hasEnd = $original.Contains($endMarker)
if ($hasBegin -ne $hasEnd) { throw 'Caddyfile contains only one synthetic-host marker.' }
$newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
$block = @(
    $beginMarker
    'http://*.jobnext.top {'
    "`thandle /__weblens-load/* {"
    "`t`treverse_proxy 127.0.0.1:19090"
    "`t}"
    "`thandle {"
    "`t`trespond 404"
    "`t}"
    '}'
    $endMarker
) -join $newline

if ($Action -eq 'enable') {
    if ($hasBegin) { Write-Status; exit 0 }
    $updated = $original.TrimEnd() + $newline + $newline + $block + $newline
} else {
    if (-not $hasBegin) { Write-Status; exit 0 }
    $managed = $block + $newline
    if (-not $original.Contains($managed)) { throw 'Synthetic-host route differs from the managed block.' }
    $updated = $original.Replace($managed, '').TrimEnd() + $newline
}

[IO.Directory]::CreateDirectory($StateRoot) | Out-Null
$backup = Join-Path $StateRoot ("Caddyfile.phase5.{0:yyyyMMddTHHmmssZ}.bak" -f [DateTime]::UtcNow)
[IO.File]::WriteAllText($backup, $original, [Text.UTF8Encoding]::new($false))
try {
    [IO.File]::WriteAllText($CaddyFile, $updated, [Text.UTF8Encoding]::new($false))
    Test-Config $CaddyFile
    Restart-Caddy
    $healthy = Test-SyntheticHosts
    if ($Action -eq 'enable' -and -not $healthy) { throw 'Synthetic-host verification failed.' }
    if ($Action -eq 'disable' -and $healthy) { throw 'Synthetic-host route is still active.' }
} catch {
    [IO.File]::WriteAllText($CaddyFile, $original, [Text.UTF8Encoding]::new($false))
    try { Test-Config $CaddyFile; Restart-Caddy } catch {}
    throw
}
Write-Status
