[CmdletBinding()]
param([ValidateSet('baseline','load')][string]$Phase = 'baseline')
$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -eq 'WIN-D1G2GS3O7J7') { throw 'Run this generator off-host' }
if ($env:K6_HTTP_DEBUG -or $env:K6_SUMMARY_EXPORT) { throw 'Unsafe k6 debug/export settings' }
$privateRoot = 'C:\Users\HP\weblens-private-recovery-20261009-856a91f6c04346cc818afbc17329f105'
$seedRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\tmp\load\phase8-worker64-150-runtime-v1-150x1000-20261003T062608Z'))
$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($entry in (Get-Acl $privateRoot).Access) {
    if ($entry.AccessControlType -ne 'Allow' -or $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Unsafe evidence root ACL' }
}
$seed = Get-Content -Raw (Join-Path $seedRoot 'seed-private.json') | ConvertFrom-Json
$users = @((Get-Content -Raw (Join-Path $seedRoot '150-scans\mixed-seed.json') | ConvertFrom-Json).users)
if ($users.Count -ne 150) { throw 'Expected the inspected 150-owner cohort' }
foreach ($user in $users) {
    $match = @($seed.entries | Where-Object { $_.email -eq $user.email -and $_.websiteId -eq $user.websiteId })
    if ($match.Count -ne 1 -or $user.email -notmatch '^phase5-.*@jobnext\.top$' -or ($user.scanId -and $user.scanId -notmatch '^[a-f0-9-]{36}$')) { throw 'Cohort identity mismatch' }
}
$output = Join-Path $privateRoot ('local-redis-vps-' + $Phase + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
$script = Join-Path $PSScriptRoot 'k6\mixed-activity.js'
Copy-Item $script (Join-Path $output 'mixed-activity.js')
$secure = ConvertTo-SecureString ([IO.File]::ReadAllText((Join-Path $seedRoot 'credentials-private.dpapi')))
$password = [Net.NetworkCredential]::new('', $secure).Password
$values = @{ WEBLENS_BASE_URL='https://jobnext.top'; WEBLENS_ALLOW_REMOTE='1'; WEBLENS_CONFIRM_TARGET_HOST='jobnext.top';
    WEBLENS_ACK_HIGH_LOAD='1'; WEBLENS_MIXED_AUTH_MODE='paced'; WEBLENS_MIXED_ALLOW_MISSING_SCAN='1'; WEBLENS_MIXED_PASSWORD=$password }
$saved = @{}
$runs = if ($Phase -eq 'baseline') { @(@{name='25-owners-baseline';vus=25;duration='60s';rate=0;think=3}) } else {
    @(@{name='50-owners';vus=50;duration='120s';rate=0;think=0.5},
      @{name='150-owners-300rps';vus=150;duration='180s';rate=300;think=0},
      @{name='150-owners-100rps-soak';vus=150;duration='10m';rate=100;think=0})
}
$record = [ordered]@{ target='https://jobnext.top'; phase=$Phase; scope='AUTHENTICATED_READS_EXISTING_OWNED_SCAN_DATA';
    startedAtUtc=[DateTime]::UtcNow.ToString('o'); generator=[Environment]::MachineName; runs=@(); newScansCreated=$false;
    scriptSha256=(Get-FileHash $script).Hash.ToLowerInvariant(); ownersWithScan=@($users | Where-Object scanId).Count;
    ownersWithoutScan=@($users | Where-Object { -not $_.scanId }).Count; sqlDdlExecuted=$false }
try {
    foreach ($name in ($values.Keys + @('WEBLENS_MIXED_SEED_FILE','WEBLENS_MIXED_VUS','WEBLENS_MIXED_DURATION','WEBLENS_MIXED_RATE','WEBLENS_MIXED_THINK_SECONDS','WEBLENS_SAFE_SUMMARY_FILE'))) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
    }
    foreach ($name in $values.Keys) { [Environment]::SetEnvironmentVariable($name,$values[$name],'Process') }
    foreach ($run in $runs) {
        $runDir = Join-Path $output $run.name
        New-Item -ItemType Directory -Path $runDir | Out-Null
        $seedFile = Join-Path $runDir 'seed.json'
        [IO.File]::WriteAllText($seedFile, (@{users=@($users | Select-Object -First $run.vus)} | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        $env:WEBLENS_MIXED_SEED_FILE=$seedFile
        $env:WEBLENS_MIXED_VUS=[string]$run.vus
        $env:WEBLENS_MIXED_DURATION=$run.duration
        $env:WEBLENS_MIXED_RATE=[string]$run.rate
        $env:WEBLENS_MIXED_THINK_SECONDS=[string]$run.think
        $env:WEBLENS_SAFE_SUMMARY_FILE=Join-Path $runDir 'summary.json'
        Write-Output "Starting $($run.name): $($run.vus) distinct owners, rate=$($run.rate), duration=$($run.duration)"
        $start = [DateTime]::UtcNow
        & k6.exe run --quiet --no-color --log-output "file=$(Join-Path $runDir 'k6.log')" `
            --out "json=$(Join-Path $runDir 'metrics.jsonl')" (Join-Path $output 'mixed-activity.js')
        $code = $LASTEXITCODE
        $record.runs += [pscustomobject]@{ name=$run.name;vus=$run.vus;rate=$run.rate;duration=$run.duration;thinkSeconds=$run.think;
            startedAtUtc=$start.ToString('o');finishedAtUtc=[DateTime]::UtcNow.ToString('o');exitCode=$code }
        # A failed SLO is evidence, not success; later lower-rate recovery is still useful.
        Write-Output "Finished $($run.name): exit=$code"
        if ($code -notin @(0,99)) { break } # A setup/generator failure cannot establish a workload.
    }
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
    $password=$null; $values=$null; $secure.Dispose()
    $record.finishedAtUtc=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $output 'manifest.json'), ($record | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    [pscustomobject]@{ evidence=$output;runs=$record.runs } | ConvertTo-Json -Depth 5 -Compress
}
