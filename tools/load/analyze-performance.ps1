[CmdletBinding()]
param([Parameter(Mandatory)][string]$RunDirectory, [ValidateSet(25,50,150,500)][int]$ScanCount = 150)
$ErrorActionPreference='Stop'
$level=Join-Path $RunDirectory "$ScanCount-scans"
$scans=@(Get-Content (Join-Path $level 'scans.json') -Raw | ConvertFrom-Json -DateKind String)
function Percentile($Values,[double]$P) {
    $sorted=@($Values|Sort-Object)
    if (-not $sorted.Count) { return $null }
    $offset=($sorted.Count-1)*$P
    $lower=[int][Math]::Floor($offset)
    $upper=[int][Math]::Ceiling($offset)
    return [double]$sorted[$lower]+([double]$sorted[$upper]-[double]$sorted[$lower])*($offset-$lower)
}
$endpoints=@{}
$reader=[IO.StreamReader]::new((Join-Path $level 'mixed.jsonl'))
try {
    while ($null -ne ($line=$reader.ReadLine())) {
        $entry=$line|ConvertFrom-Json
        if ($entry.type -ne 'Point' -or $entry.metric -notin @('http_req_duration','http_req_failed')) { continue }
        $name=[string]$entry.data.tags.name
        if (-not $endpoints.ContainsKey($name)) { $endpoints[$name]=@{durations=[Collections.Generic.List[double]]::new();errors=0} }
        if ($entry.metric -eq 'http_req_duration') { $endpoints[$name].durations.Add([double]$entry.data.value) }
        elseif ($entry.data.value -gt 0) { $endpoints[$name].errors++ }
    }
} finally { $reader.Dispose() }
$api=@(foreach ($name in @($endpoints.Keys|Sort-Object)) {
    $entry=$endpoints[$name]
    [pscustomobject]@{name=$name;requests=$entry.durations.Count;errors=$entry.errors;p50Ms=Percentile $entry.durations 0.5;p95Ms=Percentile $entry.durations 0.95;p99Ms=Percentile $entry.durations 0.99}
})
$queue=@($scans|Where-Object { $_.startedAt -and $_.createdAt }|ForEach-Object { ([DateTimeOffset]::Parse($_.startedAt)-[DateTimeOffset]::Parse($_.createdAt)).TotalSeconds })
$completion=@($scans|ForEach-Object { ([DateTimeOffset]::Parse($_.finishedAt)-[DateTimeOffset]::Parse($_.createdAt)).TotalSeconds })
$result=[ordered]@{
    runDirectory=[IO.Path]::GetFullPath($RunDirectory)
    count=$scans.Count
    distinctScans=@($scans.scanId|Select-Object -Unique).Count
    statuses=@($scans|Group-Object status|ForEach-Object { [pscustomobject]@{status=$_.Name;count=$_.Count} })
    succeededPages=($scans|ForEach-Object {$_.progress.succeeded}|Measure-Object -Sum).Sum
    failedPages=($scans|ForEach-Object {$_.progress.failed}|Measure-Object -Sum).Sum
    queueSeconds=@{p50=Percentile $queue 0.5;p95=Percentile $queue 0.95;max=($queue|Measure-Object -Maximum).Maximum}
    userCompletionSeconds=@{p50=Percentile $completion 0.5;p95=Percentile $completion 0.95;max=($completion|Measure-Object -Maximum).Maximum}
    api=$api
}
$json=$result|ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $RunDirectory 'analysis.json'),$json,[Text.UTF8Encoding]::new($false))
$json
