[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('install', 'status', 'uninstall')]
    [string] $Action
)

$ErrorActionPreference = 'Stop'
$serviceName = 'WebLensFixture'
$root = 'C:\ProgramData\WebLens\performance-fixture'
$runtime = Join-Path $root 'runtime'
$serviceLog = Join-Path $runtime 'service'
$wrapper = Join-Path $root 'WebLensFixture.exe'
$configuration = Join-Path $root 'WebLensFixture.xml'
$winsw = 'C:\WebLens\runtime\winsw.exe'
$healthUrl = 'http://127.0.0.1:19090/__weblens-load/__fixture/health'

function Get-Health {
    try {
        $health = Invoke-RestMethod -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
        if ($health.status -eq 'UP') { return $health }
    } catch {}
    return $null
}

function Write-Status {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    $health = Get-Health
    [pscustomobject]@{
        installed = $null -ne $service
        running = $null -ne $service -and $service.Status -eq 'Running'
        healthy = $null -ne $health
        serviceAccount = if ($null -ne $service) {
            (Get-CimInstance Win32_Service -Filter "Name='$serviceName'").StartName
        } else { $null }
        url = 'http://127.0.0.1:19090/__weblens-load/'
        pageCount = if ($null -ne $health) { $health.pageCount } else { $null }
    } | ConvertTo-Json -Compress
}

if ($Action -eq 'status') {
    Write-Status
    exit 0
}

if ($Action -eq 'uninstall') {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -ne $service) {
        if ($service.Status -ne 'Stopped') {
            Stop-Service -Name $serviceName -Force
            $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
        }
        & $wrapper uninstall | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not uninstall WebLensFixture.' }
    }
    Write-Status
    exit 0
}

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    throw 'WebLensFixture is already installed.'
}
if (Get-NetTCPConnection -LocalPort 19090 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 19090 is occupied. Stop the manually started fixture first.'
}
foreach ($path in @($winsw, $configuration, (Join-Path $root 'fixture.mjs'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file not found: $path" }
}

[IO.Directory]::CreateDirectory($serviceLog) | Out-Null
Copy-Item -LiteralPath $winsw -Destination $wrapper -Force
& $wrapper install | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not install WebLensFixture.' }

try {
    & sc.exe config $serviceName obj= "NT SERVICE\$serviceName" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not assign the virtual service account.' }
    & icacls.exe $root '/grant' "NT SERVICE\${serviceName}:(OI)(CI)RX" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant fixture read access.' }
    & icacls.exe $runtime '/grant' "NT SERVICE\${serviceName}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant runtime write access.' }

    Start-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $health = Get-Health
    } while ($null -eq $health -and [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $health) { throw 'WebLensFixture did not become healthy.' }
} catch {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    & $wrapper uninstall 2>&1 | Out-Null
    throw
}

Write-Status
