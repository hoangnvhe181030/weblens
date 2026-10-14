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
$fixtureHealthUrl = 'http://127.0.0.1:19090/__weblens-load/__fixture/health'
$publicHealthUrl = 'https://jobnext.top/__weblens-load/__fixture/health'
$publicPageUrl = 'https://jobnext.top/__weblens-load/page/999'
$outsideUrls = @(
    'https://jobnext.top/__fixture/health',
    'https://jobnext.top/__weblens-load-other/page/1'
)
$beginMarker = '# WEBLENS_LOAD_FIXTURE_BEGIN'
$endMarker = '# WEBLENS_LOAD_FIXTURE_END'

function Get-HttpResponse([string] $Url) {
    try {
        $raw = & curl.exe --silent --noproxy '*' --max-time 5 --write-out "`n%{http_code}" $Url 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $text = $raw -join "`n"
        $separator = $text.LastIndexOf("`n")
        if ($separator -lt 0 -or $text.Substring($separator + 1) -notmatch '^\d{3}$') { return $null }
        return [pscustomobject]@{ StatusCode = [int]$text.Substring($separator + 1); Content = $text.Substring(0, $separator) }
    } catch {}
    return $null
}

function Get-JsonHealth([string] $Url) {
    try {
        $response = Get-HttpResponse $Url
        if ($null -eq $response -or $response.StatusCode -ne 200) { return $null }
        $body = $response.Content | ConvertFrom-Json -ErrorAction Stop
        if ($body.status -eq 'UP') { return $body }
    } catch {}
    return $null
}

function Test-PublicPage {
    try {
        $response = Get-HttpResponse $publicPageUrl
        return $response.StatusCode -eq 200 -and $response.Content -match '<h1>Fixture page 999</h1>'
    } catch {
        return $false
    }
}

function Test-PublicIsolation {
    foreach ($url in $outsideUrls) {
        try {
            $response = Get-HttpResponse $url
            if ($null -eq $response) { return $false }
            if ($response.StatusCode -eq 404) { continue }
            if ($response.StatusCode -ne 200) { return $false }
            if ($response.Content -match '"status"\s*:\s*"UP"' -or
                $response.Content -match '<h1>Fixture page \d+</h1>') {
                return $false
            }
        } catch {
            if ($_.Exception.Response.StatusCode.value__ -eq 404) { continue }
            return $false
        }
    }
    return $true
}

function Test-Config([string] $Path) {
    $previousErrorAction = $ErrorActionPreference
    try {
        # Caddy writes normal info logs to stderr. Windows PowerShell otherwise
        # promotes them to NativeCommandError because this script uses Stop.
        $ErrorActionPreference = 'Continue'
        $validation = & $CaddyExe validate --config $Path --adapter caddyfile 2>&1 | Out-String
        $validationExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($validationExitCode -ne 0) { throw "Caddy validation failed: $validation" }
}

function Restart-Caddy {
    Restart-Service -Name $serviceName -Force
    $service = Get-Service -Name $serviceName
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
}

function Write-Status {
    $content = if (Test-Path -LiteralPath $CaddyFile -PathType Leaf) {
        [IO.File]::ReadAllText($CaddyFile)
    } else {
        ''
    }
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    $localHealth = Get-JsonHealth $fixtureHealthUrl
    $publicHealth = Get-JsonHealth $publicHealthUrl
    [pscustomobject]@{
        enabled = $content.Contains($beginMarker) -and $content.Contains($endMarker)
        serviceRunning = $null -ne $service -and $service.Status -eq 'Running'
        fixtureHealthy = $null -ne $localHealth
        publicFixtureHealthy = $null -ne $publicHealth -and (Test-PublicPage)
        publicIsolated = Test-PublicIsolation
        pageCount = if ($null -ne $publicHealth) { $publicHealth.pageCount } else { $null }
    } | ConvertTo-Json -Compress
}

if ($Action -eq 'status') {
    Write-Status
    exit 0
}

if (-not (Test-Path -LiteralPath $CaddyFile -PathType Leaf)) { throw "Caddyfile not found: $CaddyFile" }
if (-not (Test-Path -LiteralPath $CaddyExe -PathType Leaf)) { throw "Caddy executable not found: $CaddyExe" }
if ($null -eq (Get-JsonHealth $fixtureHealthUrl)) { throw 'Fixture is not healthy on loopback.' }

$original = [IO.File]::ReadAllText($CaddyFile)
$hasBegin = $original.Contains($beginMarker)
$hasEnd = $original.Contains($endMarker)
if ($hasBegin -ne $hasEnd) { throw 'Caddyfile contains only one fixture marker; inspect it manually.' }

$newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
$route = @(
    "`t$beginMarker"
    "`thandle /__weblens-load/* {"
    "`t`treverse_proxy 127.0.0.1:19090"
    "`t}"
    "`t$endMarker"
) -join $newline

if ($Action -eq 'enable') {
    if ($hasBegin) {
        Write-Status
        exit 0
    }
    $anchor = "jobnext.top, www.jobnext.top {$newline`timport weblens"
    if (-not $original.Contains($anchor)) { throw 'Expected jobnext.top site block was not found.' }
    $updated = $original.Replace($anchor, "jobnext.top, www.jobnext.top {$newline$route$newline$newline`timport weblens")
} else {
    if (-not $hasBegin) {
        Write-Status
        exit 0
    }
    $block = "$route$newline$newline"
    if (-not $original.Contains($block)) { throw 'Fixture route differs from the managed block; inspect it manually.' }
    $updated = $original.Replace($block, '')
}

[IO.Directory]::CreateDirectory($StateRoot) | Out-Null
$backup = Join-Path $StateRoot ("Caddyfile.{0:yyyyMMddTHHmmssZ}.bak" -f [DateTime]::UtcNow)
[IO.File]::WriteAllText($backup, $original, [Text.UTF8Encoding]::new($false))

try {
    [IO.File]::WriteAllText($CaddyFile, $updated, [Text.UTF8Encoding]::new($false))
    Test-Config $CaddyFile
    Restart-Caddy
    if ($Action -eq 'enable') {
        if ($null -eq (Get-JsonHealth $publicHealthUrl) -or
            -not (Test-PublicPage) -or
            -not (Test-PublicIsolation)) {
            throw 'Public fixture verification failed.'
        }
    } elseif ($null -ne (Get-JsonHealth $publicHealthUrl)) {
        throw 'Public fixture route is still active after disable.'
    }
} catch {
    [IO.File]::WriteAllText($CaddyFile, $original, [Text.UTF8Encoding]::new($false))
    try { Test-Config $CaddyFile; Restart-Caddy } catch {}
    throw
}

Write-Status
