[CmdletBinding()]
param(
    [ValidateSet('install','restore','status')][string]$Action = 'status',
    [ValidateSet('Backend','Crawler','Capture')][string]$Component = 'Backend',
    [Alias('JarPath')][string]$ArtifactPath,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$Sha256,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedCurrentSha256,
    [ValidatePattern('^[a-z0-9-]{1,40}$')][string]$PatchName = 'api-transaction-patch',
    [string]$SourceCommit,
    [ValidatePattern('^[0-9a-f]{40}$')][string]$BaseCommit = '9e87e8b0c95ea1791dcc4814793e45b1e391ca36'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$directory = Join-Path 'C:\ProgramData\WebLens\performance-fixture\runtime' $PatchName
$marker = Join-Path $directory 'manifest.json'
$target = 'C:\WebLens\current\backend\weblens-backend.jar'
$backup = Join-Path $directory 'original-backend.jar'
$serviceName = 'WebLensBackend'
$port = 8080
$healthUrl = 'http://127.0.0.1:8080/actuator/health'
if ($Component -eq 'Crawler') {
    if (-not $PSBoundParameters.ContainsKey('PatchName')) {
        $directory = 'C:\ProgramData\WebLens\performance-fixture\runtime\crawler-report-patch'
    }
    $marker = Join-Path $directory 'manifest.json'
    $target = 'C:\WebLens\current\crawler\weblens-crawler.exe'
    $backup = Join-Path $directory 'original-crawler.exe'
    $serviceName = 'WebLensCrawler'
    $port = 8081
    $healthUrl = 'http://127.0.0.1:8081/health/ready'
}
if ($Component -eq 'Capture') {
    $target = 'C:\WebLens\current\capture-worker\dist\analytics.js'
    $backup = Join-Path $directory 'original-analytics.js'
    $serviceName = 'WebLensCapture'
    $port = 8082
    $healthUrl = 'http://127.0.0.1:8082/health/ready'
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Stop-Component {
    $capturePid = $null
    if ($Component -eq 'Capture') {
        $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        $pids = @($listeners.OwningProcess | Select-Object -Unique)
        if ($pids.Count -gt 1) { throw 'Ambiguous Capture listener; no process stopped.' }
        if ($pids.Count -eq 1) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($pids[0])"
            if ($process.ExecutablePath -ne 'C:\WebLens\runtime\node22\node.exe' -or
                $process.CommandLine -notmatch '(?i)(^|\s)"?dist[\\/]index\.js"?(\s|$)') {
                throw 'Capture listener is not the expected WebLens process.'
            }
            $capturePid = $pids[0]
        }
    }
    Stop-Service $serviceName -ErrorAction Stop
    if ($Component -eq 'Crawler') {
        Get-CimInstance Win32_Process -Filter "Name='weblens-crawler.exe'" |
            Where-Object { $_.ExecutablePath -eq $target } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
    } elseif ($Component -eq 'Capture') {
        if ($capturePid -and (Get-Process -Id $capturePid -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $capturePid -Force -ErrorAction Stop
        }
    } else {
        Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
            Where-Object { $_.ExecutablePath -eq 'C:\WebLens\runtime\jre21\bin\java.exe' -and
                $_.CommandLine -match '(?i)(^|\s)-jar\s+weblens-backend\.jar(\s|$)' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
    }
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        throw "$Component port remains occupied."
    }
}
function Start-HealthyComponent {
    Start-Service $serviceName
    $timer = [Diagnostics.Stopwatch]::StartNew()
    # The inspected VPS needs about 85 seconds for a cold Java startup.
    while ($timer.Elapsed.TotalSeconds -lt 180) {
        try {
            $body = & curl.exe --fail --silent --show-error --noproxy '*' --max-time 3 $healthUrl 2>$null
            if ($LASTEXITCODE -eq 0 -and (($body | ConvertFrom-Json).status -eq 'UP')) { return }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw "Patched $Component failed health check."
}
if ($Action -eq 'status') {
    [pscustomobject]@{ hash=Hash $target; patch=if(Test-Path $marker){Get-Content $marker -Raw|ConvertFrom-Json}else{$null} } | ConvertTo-Json -Depth 6 -Compress
    return
}
$mutex=[Threading.Mutex]::new($false,'Global\WebLensDeployment')
if (-not $mutex.WaitOne(0)) { throw 'Another deployment is running.' }
$poll = Get-ScheduledTask -TaskName WebLensDeployPoll -ErrorAction SilentlyContinue
$pollEnabled = $poll -and $poll.State.ToString() -ne 'Disabled'
try {
    if ($pollEnabled) { Disable-ScheduledTask -TaskName WebLensDeployPoll | Out-Null }
    $release=Get-Content 'C:\WebLens\current\release.json' -Raw|ConvertFrom-Json
    if ($release.commit -ne $baseCommit) { throw 'Base release changed; patch aborted.' }
    if ($Action -eq 'install') {
        if (-not $ArtifactPath -or -not $Sha256 -or -not $SourceCommit) { throw 'Artifact, hash and source commit are required.' }
        if ((Hash $ArtifactPath) -ne $Sha256.ToLowerInvariant()) { throw 'Patch checksum mismatch.' }
        if (Test-Path $marker) { throw 'Patch already installed; inspect status before replacing it.' }
        [IO.Directory]::CreateDirectory($directory)|Out-Null
        if (Test-Path $backup) { throw 'Previous backup exists; preserve it and inspect before installing.' }
        $oldHash=Hash $target
        if ($Component -in @('Crawler','Capture') -and -not $ExpectedCurrentSha256) { throw 'Worker installation requires the expected current hash.' }
        if ($ExpectedCurrentSha256 -and $oldHash -ne $ExpectedCurrentSha256.ToLowerInvariant()) { throw 'Current artifact changed; patch aborted.' }
        Copy-Item -LiteralPath $target -Destination $backup
        if ((Hash $backup) -ne $oldHash) { throw 'Backup checksum mismatch.' }
        try {
            Stop-Component
            Copy-Item -LiteralPath $ArtifactPath -Destination $target -Force
            if ((Hash $target) -ne $Sha256.ToLowerInvariant()) { throw 'Installed checksum mismatch.' }
            Start-HealthyComponent
            $value=[ordered]@{baseCommit=$baseCommit;sourceCommit=$SourceCommit;component=$Component;artifactSha256=$Sha256.ToLowerInvariant();originalSha256=$oldHash;installedAtUtc=[DateTime]::UtcNow.ToString('o');restored=$false}
            if ($Component -eq 'Backend') { $value.backendSha256 = $Sha256.ToLowerInvariant() }
            [IO.File]::WriteAllText($marker,($value|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        } catch {
            $failure=$_
            Stop-Component
            Copy-Item -LiteralPath $backup -Destination $target -Force
            if ((Hash $target) -ne $oldHash) { throw 'Automatic rollback checksum mismatch.' }
            Start-HealthyComponent
            throw $failure
        }
    } else {
        if (-not (Test-Path $marker)) { throw 'Patch manifest is missing.' }
        $value=Get-Content $marker -Raw|ConvertFrom-Json
        if ($value.component -and $value.component -ne $Component) { throw 'Patch component mismatch.' }
        $installedHash = if ($value.artifactSha256) { $value.artifactSha256 } else { $value.backendSha256 }
        if ((Hash $backup) -ne $value.originalSha256 -or (Hash $target) -ne $installedHash) {
            throw 'Artifact changed; automatic restore aborted.'
        }
        Stop-Component
        Copy-Item -LiteralPath $backup -Destination $target -Force
        if ((Hash $target) -ne $value.originalSha256) { throw 'Restored artifact checksum mismatch.' }
        Start-HealthyComponent
        $value.restored=$true
        [IO.File]::WriteAllText($marker,($value|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    }
    [pscustomobject]@{action=$Action;component=$Component;healthy=$true;hash=Hash $target;manifest=$marker}|ConvertTo-Json -Compress
} finally {
    if ($pollEnabled) { Enable-ScheduledTask -TaskName WebLensDeployPoll | Out-Null }
    $mutex.ReleaseMutex();$mutex.Dispose()
}
