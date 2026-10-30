[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('start', 'status', 'stop')]
    [string] $Action,

    [ValidateRange(1024, 65535)]
    [int] $Port = 19090,

    [ValidateRange(1, 1000)]
    [int] $Pages = 1000,

    [string] $NodePath = 'C:\WebLens\runtime\node22\node.exe',

    [string] $StateRoot = 'C:\ProgramData\WebLens\performance-fixture\runtime'
)

$ErrorActionPreference = 'Stop'
$fixture = Join-Path $PSScriptRoot 'fixture.mjs'
$pidFile = Join-Path $StateRoot 'fixture.pid'
$stdout = Join-Path $StateRoot 'fixture.stdout.log'
$stderr = Join-Path $StateRoot 'fixture.stderr.log'
$healthUrl = "http://127.0.0.1:$Port/__weblens-load/__fixture/health"

function Get-FixtureProcess {
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $null }
    $savedPid = 0
    if (-not [int]::TryParse(([IO.File]::ReadAllText($pidFile).Trim()), [ref]$savedPid)) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
    if ($null -eq $process -or $process.Name -notmatch '^node(\.exe)?$') { return $null }
    if ($process.CommandLine -notlike "*$fixture*") { return $null }
    return $process
}

function Get-Health {
    try {
        return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 -UseBasicParsing
    } catch {
        return $null
    }
}

if ($Action -eq 'status') {
    $process = Get-FixtureProcess
    $health = Get-Health
    [pscustomobject]@{
        running = $null -ne $process
        healthy = $null -ne $health -and $health.status -eq 'UP'
        pid = if ($null -ne $process) { $process.ProcessId } else { $null }
        url = "http://127.0.0.1:$Port/__weblens-load/"
        pageCount = if ($null -ne $health) { $health.pageCount } else { $null }
    } | ConvertTo-Json -Compress
    exit 0
}

if ($Action -eq 'stop') {
    $process = Get-FixtureProcess
    if ($null -ne $process) {
        Stop-Process -Id $process.ProcessId -Force
        Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    [pscustomobject]@{ stopped = $true; pid = if ($null -ne $process) { $process.ProcessId } else { $null } } |
        ConvertTo-Json -Compress
    exit 0
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node executable not found: $NodePath" }
if (-not (Test-Path -LiteralPath $fixture -PathType Leaf)) { throw "Fixture not found: $fixture" }
if ($null -ne (Get-FixtureProcess)) { throw 'Fixture is already running.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port already has a listener."
}

[IO.Directory]::CreateDirectory($StateRoot) | Out-Null
foreach ($path in @($stdout, $stderr)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

$arguments = @(
    $fixture,
    '--host', '127.0.0.1',
    '--port', $Port,
    '--pages', $Pages,
    '--fanout', 10,
    '--delay', '2ms',
    '--body-bytes', 4096,
    '--base-path', '/__weblens-load',
    '--robots', 'allow'
)
$started = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
[IO.File]::WriteAllText($pidFile, [string]$started.Id, [Text.UTF8Encoding]::new($false))

$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    Start-Sleep -Milliseconds 250
    $health = Get-Health
    if ($null -ne $health -and $health.status -eq 'UP') {
        [pscustomobject]@{
            started = $true
            pid = $started.Id
            url = "http://127.0.0.1:$Port/__weblens-load/"
            pageCount = $health.pageCount
        } | ConvertTo-Json -Compress
        exit 0
    }
} while ([DateTime]::UtcNow -lt $deadline -and -not $started.HasExited)

if (-not $started.HasExited) { Stop-Process -Id $started.Id -Force }
if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
throw "Fixture failed to become healthy. Read $stderr"
