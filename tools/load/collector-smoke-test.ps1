$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtime = Join-Path $root 'tmp\load\collector-smoke'
$environmentFile = Join-Path $runtime 'fake.env'
$outputFile = Join-Path $runtime 'sample.jsonl'
$secret = 'COLLECTOR_SECRET_MUST_NOT_LEAK'

$collectorPath=Join-Path $PSScriptRoot 'collect-windows.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($collectorPath,[ref]$null,[ref]$null)
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-BrowserProcessCounts'},$true)
Invoke-Expression $function.Extent.Text
$counts=Get-BrowserProcessCounts @(
    [pscustomobject]@{Name='camoufox.exe';ExecutablePath='C:\WebLens\current\capture-worker\camoufox\camoufox.exe'},
    [pscustomobject]@{Name='chrome-headless-shell.exe';ExecutablePath='C:\WebLens\releases\abc\capture-worker\node_modules\chrome-headless-shell.exe'},
    [pscustomobject]@{Name='chrome.exe';ExecutablePath='C:\Users\Administrator\MoreLogin\chrome.exe'},
    [pscustomobject]@{Name='chrome.exe';ExecutablePath=$null},
    [pscustomobject]@{Name='node.exe';ExecutablePath='C:\WebLens\runtime\node22\node.exe'}
)
if($counts.total -ne 4 -or $counts.weblens -ne 2 -or $counts.external -ne 1 -or $counts.unknown -ne 1){throw 'Browser attribution failed'}

if (Test-Path -LiteralPath $runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force }
[IO.Directory]::CreateDirectory($runtime) | Out-Null

$environment = @(
    'DB_URL=jdbc:postgresql://127.0.0.1:1/weblens'
    'DB_USERNAME=test'
    "DB_PASSWORD=$secret"
    "CRAWLER_POSTGRES_URL=postgres://crawler:$secret@127.0.0.1:1/crawler"
    "CAPTURE_DATABASE_URL=postgres://capture:$secret@127.0.0.1:1/capture"
    "WEBLENS_SERVICE_TOKEN=$secret"
    'CLICKHOUSE_URL=http://127.0.0.1:1'
    'CLICKHOUSE_USERNAME=test'
    "CLICKHOUSE_PASSWORD=$secret"
    'CRAWLER_CLICKHOUSE_USERNAME=test'
    "CRAWLER_CLICKHOUSE_PASSWORD=$secret"
) -join "`n"
[IO.File]::WriteAllText($environmentFile, $environment, [Text.UTF8Encoding]::new($false))

try {
    & (Join-Path $PSScriptRoot 'collect-windows.ps1') `
        -OutputPath $outputFile `
        -DurationSeconds 0 `
        -IntervalSeconds 1 `
        -ProductionTelemetry `
        -EnvironmentFile $environmentFile `
        -PostgresBin (Join-Path $runtime 'missing-postgres')

    $raw = [IO.File]::ReadAllText($outputFile)
    if ($raw.Contains($secret)) { throw 'Collector leaked a secret into its output' }
    $sample = $raw | ConvertFrom-Json
    if ($sample.schemaVersion -ne 2) { throw 'Unexpected collector schema version' }
    if ($sample.postgres.control.status -ne 'psql-missing' -or
        $sample.postgres.crawler.status -ne 'psql-missing' -or
        $sample.postgres.capture.status -ne 'psql-missing') {
        throw 'Collector did not report missing PostgreSQL tooling safely'
    }
    if ($sample.actuator.status -ne 'unavailable' -or
        $sample.clickHouse.crawl.status -ne 'unavailable' -or
        $sample.clickHouse.capture.status -ne 'unavailable') {
        throw 'Collector did not report unavailable telemetry safely'
    }
    [pscustomobject]@{ outcome = 'PASSED'; schemaVersion = $sample.schemaVersion } |
        ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue
}
