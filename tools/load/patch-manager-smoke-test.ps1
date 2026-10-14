[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'manage-performance-patch-windows.ps1'))
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$testRoot = [IO.Path]::GetFullPath((Join-Path $repo ('tmp\load\patch-manager-check-' + [Guid]::NewGuid().ToString('N'))))
if (-not $testRoot.StartsWith([IO.Path]::GetFullPath((Join-Path $repo 'tmp\load')) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid test root.' }

# Rewrite fixed production paths into a fresh local fixture. All service,
# process and HTTP operations below are mocks, not native commands.
function Stop-Service { [CmdletBinding()]param([string]$Name) $global:WebLensPatchCheck.stops += $Name }
function Start-Service {
    [CmdletBinding()]param([string]$Name)
    if ($global:WebLensPatchCheck.failStartup -and [IO.File]::ReadAllText($global:WebLensPatchCheck.target) -eq 'candidate') { throw 'Simulated startup failure.' }
    $global:WebLensPatchCheck.starts += $Name
}
function Get-CimInstance {
    [CmdletBinding()]param([string]$ClassName, [string]$Filter)
    if ($Filter -eq 'ProcessId=10') {
        return @{ ExecutablePath = $global:WebLensPatchCheck.processPath; CommandLine = $global:WebLensPatchCheck.commandLine; ProcessId = 10 }
    }
    @{ ExecutablePath = $global:WebLensPatchCheck.processPath; CommandLine = '-jar weblens-backend.jar'; ProcessId = 10 }
    @{ ExecutablePath = 'C:\OtherApp\unrelated.exe'; CommandLine = '-jar weblens-backend.jar'; ProcessId = 11 }
}
function Stop-Process { [CmdletBinding()]param([int]$Id, [switch]$Force) $global:WebLensPatchCheck.killed += $Id }
function Get-NetTCPConnection {
    [CmdletBinding()]param([int]$LocalPort, [string]$State)
    if ($global:WebLensPatchCheck.capture -and $global:WebLensPatchCheck.stops.Count -eq 0) { @{OwningProcess=10} }
}
function curl.exe { $global:LASTEXITCODE=0; '{"status":"UP"}' }
function Get-ScheduledTask { [CmdletBinding()]param([string]$TaskName) }

try {
    foreach ($case in @('Crawler','NamedCrawler','Backend','NamedBackend','Capture','CaptureForeign','Rollback','HashGuard','NewBase')) {
        $root = Join-Path $testRoot $case
        $component = if ($case -in @('Backend','NamedBackend')) { 'Backend' } elseif ($case -in @('Capture','CaptureForeign')) { 'Capture' } else { 'Crawler' }
        $webRoot = Join-Path $root 'WebLens'
        $dataRoot = Join-Path $root 'ProgramData'
        $target = Join-Path $webRoot $(if ($component -eq 'Crawler') { 'current\crawler\weblens-crawler.exe' } elseif ($component -eq 'Capture') { 'current\capture-worker\dist\analytics.js' } else { 'current\backend\weblens-backend.jar' })
        [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
        [IO.File]::WriteAllText($target, 'original')
        $base = if ($case -eq 'NewBase') { '6ade9332e2e4c4df12b304edecad5d756462143f' } else { '9e87e8b0c95ea1791dcc4814793e45b1e391ca36' }
        [IO.File]::WriteAllText((Join-Path $webRoot 'current\release.json'), ('{"commit":"' + $base + '"}'))
        $artifact = Join-Path $root 'candidate.bin'
        [IO.File]::WriteAllText($artifact, 'candidate')
        $originalHash = (Get-FileHash $target).Hash.ToLowerInvariant()
        $newHash = (Get-FileHash $artifact).Hash.ToLowerInvariant()
        $global:WebLensPatchCheck = @{target=$target; processPath=$(if($component -eq 'Crawler'){$target}else{Join-Path $webRoot 'runtime\jre21\bin\java.exe'}); stops=@();starts=@();killed=@();failStartup=($case -eq 'Rollback')}
        $global:WebLensPatchCheck.capture = $component -eq 'Capture'
        if ($component -eq 'Capture') {
            $global:WebLensPatchCheck.processPath=Join-Path $webRoot 'runtime\node22\node.exe'
            $global:WebLensPatchCheck.commandLine=if($case -eq 'CaptureForeign'){'other\index.js'}else{'"node.exe" dist\index.js'}
        }
        $mapped = $source.Replace('C:\ProgramData\WebLens', $dataRoot).Replace('C:\WebLens', $webRoot).Replace('Global\WebLensDeployment', 'WebLensPatchCheck-'+[Guid]::NewGuid().ToString('N'))
        if ($mapped.Contains('C:\WebLens\') -or $mapped.Contains('C:\ProgramData\WebLens\')) { throw 'Production path survived rewrite.' }
        $script = [ScriptBlock]::Create($mapped)
        $arguments = @{Action='install';Sha256=$newHash;SourceCommit=('a'*40)}
        if ($component -in @('Crawler','Capture')) {
            $arguments.Component=$component; $arguments.ArtifactPath=$artifact; $arguments.ExpectedCurrentSha256=$(if($case -eq 'HashGuard'){'0'*64}else{$originalHash})
            if ($case -eq 'NewBase') { $arguments.BaseCommit=$base }
            if ($case -eq 'NamedCrawler') { $arguments.PatchName='crawler-diagnosis-20261002' }
        }
        else {
            $arguments.JarPath=$artifact
            $arguments.ExpectedCurrentSha256=$originalHash
            if ($case -eq 'NamedBackend') { $arguments.PatchName='admission-timing-20261002' }
        }
        $failed=$false
        try { $result = (& $script @arguments) | ConvertFrom-Json } catch { $failed=$true }
        if ($case -in @('Rollback','HashGuard','CaptureForeign')) {
            if (-not $failed -or (Get-FileHash $target).Hash.ToLowerInvariant() -ne $originalHash) { throw "$case did not preserve original artifact." }
            if ($case -eq 'HashGuard' -and $global:WebLensPatchCheck.stops.Count -ne 0) { throw 'Hash mismatch stopped a service.' }
            if ($case -eq 'CaptureForeign' -and $global:WebLensPatchCheck.stops.Count -ne 0) { throw 'Foreign Capture listener was stopped.' }
            if ($case -eq 'Rollback' -and $global:WebLensPatchCheck.starts.Count -ne 1) { throw 'Rollback did not restart the original service.' }
        } else {
            if ($failed -or $result.hash -ne $newHash) { throw "$case installation failed." }
            if ($case -eq 'NamedCrawler' -and $result.manifest -notlike '*\crawler-diagnosis-20261002\manifest.json') { throw 'Named Crawler patch reused the legacy directory.' }
            if ($case -eq 'Backend') {
                $manifest = Join-Path $dataRoot 'performance-fixture\runtime\api-transaction-patch\manifest.json'
                $legacy = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
                $legacy.PSObject.Properties.Remove('artifactSha256')
                $legacy.PSObject.Properties.Remove('component')
                [IO.File]::WriteAllText($manifest, ($legacy | ConvertTo-Json))
            }
            $restoreArgs = @{ Action='restore'; Component=$component }
            if ($case -eq 'NewBase') { $restoreArgs.BaseCommit=$base }
            if ($case -eq 'NamedBackend') { $restoreArgs.PatchName='admission-timing-20261002' }
            if ($case -eq 'NamedCrawler') { $restoreArgs.PatchName='crawler-diagnosis-20261002' }
            $restore = (& $script @restoreArgs) | ConvertFrom-Json
            if ($restore.hash -ne $originalHash) { throw "$case restore failed." }
        }
        if (@($global:WebLensPatchCheck.killed | Where-Object {$_ -ne 10}).Count) { throw 'Stopped an unrelated process.' }
        $expectedService = 'WebLens' + $component
        if (@($global:WebLensPatchCheck.stops | Where-Object {$_ -ne $expectedService}).Count) { throw 'Stopped an unrelated service.' }
        "PASS $case"
    }
} finally { Remove-Variable WebLensPatchCheck -Scope Global -ErrorAction SilentlyContinue }
