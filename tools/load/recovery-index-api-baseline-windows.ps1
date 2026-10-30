# Two bounded read-only maintenance baselines, not a capacity/admission benchmark.
$ErrorActionPreference = 'Stop'
if ($env:K6_HTTP_DEBUG -or $env:K6_SUMMARY_EXPORT) { throw 'Unsafe k6 debug/export environment; no requests sent' }
$privateRoot = 'C:\Users\HP\weblens-private-recovery-20261009-856a91f6c04346cc818afbc17329f105'
$seedRoot = Join-Path $PSScriptRoot '..\..\tmp\load\phase8-worker64-150-runtime-v1-150x1000-20261003T062608Z'
$script = Join-Path $PSScriptRoot 'k6\api-read.js'
if ($env:COMPUTERNAME -eq 'WIN-D1G2GS3O7J7') { throw 'Run this generator off-host only' }
$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
if (-not (Test-Path -LiteralPath $privateRoot -PathType Container)) { throw 'Private root missing' }
foreach ($entry in (Get-Acl -LiteralPath $privateRoot).Access) {
    if ($entry.AccessControlType -ne 'Allow' -or $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Unsafe private root ACL' }
}
$seed = Get-Content -Raw -LiteralPath (Join-Path $seedRoot 'seed-private.json') | ConvertFrom-Json
$mixed = Get-Content -Raw -LiteralPath (Join-Path $seedRoot '150-scans\mixed-seed.json') | ConvertFrom-Json
$user = @($mixed.users | Where-Object { $_.scanId -match '^[a-f0-9-]{36}$' })[0]
if (-not $user -or $user.websiteId -notmatch '^[a-f0-9-]{36}$') { throw 'No known owned scan identity' }
$matching = @($seed.entries | Where-Object { $_.email -eq $user.email -and $_.websiteId -eq $user.websiteId })
if ($matching.Count -ne 1 -or $user.email -notmatch '^phase5-.*@jobnext\.top$') { throw 'Seed ownership mismatch' }
$secure = ConvertTo-SecureString ([IO.File]::ReadAllText((Join-Path $seedRoot 'credentials-private.dpapi')))
$password = [Net.NetworkCredential]::new('', $secure).Password
$values = @{
    WEBLENS_BASE_URL='https://jobnext.top'; WEBLENS_ALLOW_REMOTE='1'; WEBLENS_CONFIRM_TARGET_HOST='jobnext.top'
    WEBLENS_VUS='1'; WEBLENS_DURATION='30s'; WEBLENS_EMAIL=$user.email; WEBLENS_PASSWORD=$password
    WEBLENS_WEBSITE_ID=$user.websiteId; WEBLENS_SCAN_ID=$user.scanId
    WEBLENS_TRACE_READS='1'
}
$saved = @{}
$output = Join-Path $privateRoot ('api-baseline-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
Copy-Item -LiteralPath $script -Destination (Join-Path $output 'api-read.js')
$record = [ordered]@{ scope='EXISTING_OWNED_DATA_READ_MONITOR'; createdAtUtc=[DateTime]::UtcNow.ToString('o')
    target='https://jobnext.top'; virtualUsers=1; windowsSeconds=30; plannedWindows=2
    websiteId=$user.websiteId; scanId=$user.scanId
    scriptSha256=(Get-FileHash -LiteralPath $script -Algorithm SHA256).Hash.ToLowerInvariant()
    newScansCreated=$false; productionDdlExecuted=$false; rounds=@(); outcome='INCOMPLETE'
    limitations=@('Low-rate read baseline, not 150-user capacity or admission root cause',
        'Logins create short-lived auth sessions; raw metrics omit credentials; default summary export is intentionally disabled',
        'No during-DDL monitor yet; current baselines cannot replace a fresh same-workload maintenance gate') }
try {
    foreach ($key in $values.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process')
    }
    foreach ($round in 1..2) {
        $started = [DateTime]::UtcNow
        # k6 default summary export includes setup_data, including api-read.js's bearer token.
        & k6.exe run --quiet --no-color --log-output "file=$(Join-Path $output "round-$round.log")" `
            --out "json=$(Join-Path $output "round-$round.jsonl")" `
            (Join-Path $output 'api-read.js')
        $exit = $LASTEXITCODE
        $record.rounds += [pscustomobject]@{ round=$round; startedAtUtc=$started.ToString('o'); finishedAtUtc=[DateTime]::UtcNow.ToString('o'); exit=$exit }
        if ($exit -ne 0) { $record.outcome='BASELINE_GATE_FAILED'; break }
    }
    if ($record.rounds.Count -eq 2 -and @($record.rounds | Where-Object exit -ne 0).Count -eq 0) { $record.outcome='BASELINE_CAPTURED' }
} catch { $record.outcome='BASELINE_INCOMPLETE_ERROR'; throw 'Read baseline failed; private evidence retained' }
finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    $password=$null; $values=$null; $secure.Dispose()
    $record.finishedAtUtc=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $output 'manifest.json'), ($record | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    [pscustomobject]@{ outcome=$record.outcome; evidence=$output; rounds=$record.rounds; productionDdlExecuted=$false } | ConvertTo-Json -Depth 5 -Compress
}
if ($record.outcome -ne 'BASELINE_CAPTURED') { exit 1 }
