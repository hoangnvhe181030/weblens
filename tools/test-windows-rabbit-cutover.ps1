$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('weblens-cutover-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$environmentFile = Join-Path $root 'weblens.env'
$environmentBackup = Join-Path $root 'previous.env'
$credentialsFile = Join-Path $root 'credentials.json'
$original = "# keep existing settings`r`nDB_PASSWORD=existing-private-value`r`nCRAWLER_CLICKHOUSE_READ_MAX_CONNS=24`r`nWEBLENS_SCAN_COMMAND_TRANSPORT=http`r`nWEBLENS_BILLING_ENABLED=true`r`n"
[IO.File]::WriteAllText($environmentFile, $original, [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $environmentFile -Destination $environmentBackup
@{weblens_control=('a' * 64);weblens_crawler=('b' * 64)} | ConvertTo-Json | Set-Content -LiteralPath $credentialsFile -Encoding ascii
$previousDependencies = @{WebLensBackend=@('WebLensPostgres','WebLensRedis');WebLensCrawler=@('WebLensPostgres')}
$script:commands = @()
function sc.exe {
    $script:commands += ($args -join ' ')
    $global:LASTEXITCODE = 0
}
try {
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../infra/production-windows/deploy.ps1'), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors) { throw 'Deploy script syntax invalid' }
    foreach ($name in @('Enable-RabbitTransport','Restore-TransportConfiguration','Stop-BackendProcesses')) {
        $definition = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
        if (-not $definition) { throw "Missing function: $name" }
        $functionText = $definition.Extent.Text.Replace('C:\ProgramData\WebLens\rabbitmq\credentials.json', $credentialsFile)
        $functionText = $functionText.Replace('[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()', '@()')
        Invoke-Expression $functionText
    }
    Enable-RabbitTransport
    $actual = [IO.File]::ReadAllText($environmentFile)
    foreach ($setting in @('DB_PASSWORD=existing-private-value','CRAWLER_CLICKHOUSE_READ_MAX_CONNS=24','WEBLENS_SCAN_COMMAND_TRANSPORT=rabbitmq','WEBLENS_BILLING_ENABLED=false',('WEBLENS_RABBITMQ_PASSWORD=' + ('a' * 64)),('CRAWLER_RABBITMQ_PASSWORD=' + ('b' * 64)))) {
        if (-not $actual.Contains($setting)) { throw 'Cutover failed to preserve or set a required setting' }
    }
    if ([regex]::Matches($actual, '(?m)^WEBLENS_SCAN_COMMAND_TRANSPORT=').Count -ne 1) { throw 'Duplicate transport settings' }
    if ($script:commands.Count -ne 2 -or $script:commands[0] -notlike '*WebLensPostgres/WebLensRedis/WebLensRabbitMQ' -or $script:commands[1] -notlike '*WebLensPostgres/WebLensRabbitMQ') { throw 'Service dependencies were not preserved' }
    Restore-TransportConfiguration
    if ([IO.File]::ReadAllText($environmentFile) -cne $original) { throw 'Rollback did not restore the exact environment bytes' }
    if ($script:commands.Count -ne 4 -or $script:commands[2] -notlike '*WebLensPostgres*' -or $script:commands[3] -notlike '*WebLensPostgres*' -or ($script:commands[2..3] -join '') -like '*WebLensRabbitMQ*') { throw 'Rollback did not restore dependencies' }
    $script:stopped = @(); $script:unexpectedOwner = $false
    function netstat.exe { $global:LASTEXITCODE=0; '  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    4242' }
    function Get-Process { param($Id,$ErrorAction) if ($script:unexpectedOwner) { @{Path='C:\unrelated\java.exe'} } else { @{Path=(Join-Path $root 'runtime\jre21\bin\java.exe')} } }
    function Stop-Process { param($Id,[switch]$Force,$ErrorAction) $script:stopped += $Id }
    function Wait-Process { param($Id,$Timeout,$ErrorAction) }
    Stop-BackendProcesses
    if ($script:stopped.Count -ne 1 -or $script:stopped[0] -ne 4242) { throw 'Backend listener owner was not stopped' }
    $script:unexpectedOwner = $true; $refused = $false
    try { Stop-BackendProcesses } catch { $refused = $true }
    if (-not $refused -or $script:stopped.Count -ne 1) { throw 'Unrelated listener owner was not protected' }
    Write-Output 'PASS: RabbitMQ cutover preserves existing settings/dependencies; rollback restores environment and dependencies'
} finally {
    foreach ($name in @('sc.exe','netstat.exe','Get-Process','Stop-Process','Wait-Process')) { Remove-Item -LiteralPath "Function:\$name" -ErrorAction SilentlyContinue }
    $resolved = [IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith(([IO.Path]::GetFullPath([IO.Path]::GetTempPath())), [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'weblens-cutover-test-*') { throw 'Unsafe test cleanup target' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
