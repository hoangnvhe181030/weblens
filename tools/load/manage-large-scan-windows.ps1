[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('enable', 'status', 'disable')]
    [string] $Action,

    [ValidateRange(1001, 100000)]
    [int] $Pages = 10000,

    [string] $EnvironmentFile = 'C:\ProgramData\WebLens\weblens.env',
    [string] $FixtureConfig = 'C:\ProgramData\WebLens\performance-fixture\WebLensFixture.xml',
    [string] $StateFile = 'C:\ProgramData\WebLens\performance-fixture\runtime\large-scan-state.json'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [Text.UTF8Encoding]::new($false)

function Get-EnvironmentPages([string] $Content) {
    $matches = [Text.RegularExpressions.Regex]::Matches(
        $Content,
        '(?m)^WEBLENS_SCAN_MAX_PAGES=(?<pages>\d+)\r?$'
    )
    if ($matches.Count -ne 1) { throw 'Expected exactly one WEBLENS_SCAN_MAX_PAGES setting.' }
    return [int]$matches[0].Groups['pages'].Value
}

function Set-EnvironmentPages([string] $Content, [int] $Value) {
    return [Text.RegularExpressions.Regex]::Replace(
        $Content,
        '(?m)^WEBLENS_SCAN_MAX_PAGES=\d+(\r?)$',
        "WEBLENS_SCAN_MAX_PAGES=$Value`$1"
    )
}

function Get-FixturePages([string] $Content) {
    $matches = [Text.RegularExpressions.Regex]::Matches($Content, '--pages\s+(?<pages>\d+)')
    if ($matches.Count -ne 1) { throw 'Expected exactly one fixture --pages argument.' }
    return [int]$matches[0].Groups['pages'].Value
}

function Set-FixturePages([string] $Content, [int] $Value) {
    return [Text.RegularExpressions.Regex]::Replace($Content, '--pages\s+\d+', "--pages $Value")
}

function Get-FixtureAcknowledgement([string] $Content) {
    return $Content -match '(?<!\S)--acknowledge-high-load(?=\s*</arguments>)'
}

function Set-FixtureAcknowledgement([string] $Content, [bool] $Enabled) {
    $without = [Text.RegularExpressions.Regex]::Replace(
        $Content,
        '\s+--acknowledge-high-load(?=\s*</arguments>)',
        ''
    )
    if (-not $Enabled) { return $without }
    return $without.Replace('</arguments>', ' --acknowledge-high-load</arguments>')
}

function Wait-ServiceHealthy([string] $Name, [string] $Uri, [int] $ExpectedPages = 0) {
    $service = Get-Service -Name $Name -ErrorAction Stop
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        try {
            $body = Invoke-RestMethod -UseBasicParsing -Uri $Uri -TimeoutSec 5
            if ($body.status -eq 'UP' -and ($ExpectedPages -eq 0 -or $body.pageCount -eq $ExpectedPages)) {
                return
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not become healthy."
}

function Restart-ManagedServices([int] $ExpectedPages) {
    Stop-Service -Name 'WebLensBackend' -Force
    (Get-Service -Name 'WebLensBackend').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(120))
    Start-Service -Name 'WebLensBackend'
    Wait-ServiceHealthy 'WebLensBackend' 'http://127.0.0.1:8080/actuator/health'
    Stop-Service -Name 'WebLensFixture' -Force
    (Get-Service -Name 'WebLensFixture').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    Start-Service -Name 'WebLensFixture'
    Wait-ServiceHealthy 'WebLensFixture' 'http://127.0.0.1:19090/__weblens-load/__fixture/health' $ExpectedPages
}

function Get-Health([string] $Uri) {
    try { return Invoke-RestMethod -UseBasicParsing -Uri $Uri -TimeoutSec 5 } catch { return $null }
}

function Write-Status {
    $environment = [IO.File]::ReadAllText($EnvironmentFile)
    $fixture = [IO.File]::ReadAllText($FixtureConfig)
    $fixtureHealth = Get-Health 'http://127.0.0.1:19090/__weblens-load/__fixture/health'
    $backendHealth = Get-Health 'http://127.0.0.1:8080/actuator/health'
    [pscustomobject]@{
        managed = Test-Path -LiteralPath $StateFile -PathType Leaf
        environmentMaxPages = Get-EnvironmentPages $environment
        fixtureConfiguredPages = Get-FixturePages $fixture
        fixtureHighLoadAcknowledged = Get-FixtureAcknowledgement $fixture
        fixtureHealthPages = if ($null -ne $fixtureHealth) { $fixtureHealth.pageCount } else { $null }
        backendHealthy = $null -ne $backendHealth -and $backendHealth.status -eq 'UP'
        fixtureHealthy = $null -ne $fixtureHealth -and $fixtureHealth.status -eq 'UP'
    } | ConvertTo-Json -Compress
}

foreach ($path in @($EnvironmentFile, $FixtureConfig)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file not found: $path" }
}

if ($Action -eq 'status') { Write-Status; exit 0 }

$environmentBefore = [IO.File]::ReadAllText($EnvironmentFile)
$fixtureBefore = [IO.File]::ReadAllText($FixtureConfig)
$environmentPagesBefore = Get-EnvironmentPages $environmentBefore
$fixturePagesBefore = Get-FixturePages $fixtureBefore
$fixtureAcknowledgementBefore = Get-FixtureAcknowledgement $fixtureBefore

if ($Action -eq 'enable') {
    if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
        if ($environmentPagesBefore -eq $Pages -and $fixturePagesBefore -eq $Pages) { Write-Status; exit 0 }
        throw 'A managed large-scan configuration already exists.'
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($StateFile)) | Out-Null
    [IO.File]::WriteAllText($StateFile, ([ordered]@{
        schemaVersion = 1
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        environmentMaxPages = $environmentPagesBefore
        fixturePages = $fixturePagesBefore
        fixtureHighLoadAcknowledged = $fixtureAcknowledgementBefore
        requestedPages = $Pages
    } | ConvertTo-Json), $utf8)
    $targetEnvironmentPages = $Pages
    $targetFixturePages = $Pages
    $targetFixtureAcknowledgement = $true
} else {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { Write-Status; exit 0 }
    $state = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
    if ($state.schemaVersion -ne 1) { throw 'Unsupported large-scan state file.' }
    $targetEnvironmentPages = [int]$state.environmentMaxPages
    $targetFixturePages = [int]$state.fixturePages
    $targetFixtureAcknowledgement = [bool]$state.fixtureHighLoadAcknowledged
}

try {
    [IO.File]::WriteAllText(
        $EnvironmentFile,
        (Set-EnvironmentPages $environmentBefore $targetEnvironmentPages),
        $utf8
    )
    [IO.File]::WriteAllText(
        $FixtureConfig,
        (Set-FixtureAcknowledgement (Set-FixturePages $fixtureBefore $targetFixturePages) $targetFixtureAcknowledgement),
        $utf8
    )
    Restart-ManagedServices $targetFixturePages
    if ($Action -eq 'disable') { [IO.File]::Delete($StateFile) }
} catch {
    [IO.File]::WriteAllText($EnvironmentFile, $environmentBefore, $utf8)
    [IO.File]::WriteAllText($FixtureConfig, $fixtureBefore, $utf8)
    try { Restart-ManagedServices $fixturePagesBefore } catch {}
    if ($Action -eq 'enable' -and (Test-Path -LiteralPath $StateFile)) { [IO.File]::Delete($StateFile) }
    throw
}

Write-Status
