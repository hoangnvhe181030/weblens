$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot '..\..\infra\production-windows\install-local-redis.ps1'
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Installer parse failed'}
$branch=$ast.Find({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and
    $node.Extent.Text.StartsWith("if (`$Action -eq 'verify') {")},$true)
if(-not $branch){throw 'Maintenance branch missing'}
$body=[ScriptBlock]::Create($branch.Clauses[0].Item2.Extent.Text.Trim().TrimStart('{').TrimEnd('}'))
function Get-Service { param([string]$Name) @{DependentServices=$script:check.dependencies;Status=$(if($script:check.redisStopped -and $script:check.verifies){'Stopped'}else{'Running'})} }
function Stop-Backend { $script:check.stops++ }
function Start-Service { param([string]$Name) if($Name -eq 'WebLensRedis'){$script:check.redisStarts++}elseif($Name -eq 'WebLensBackend'){$script:check.starts++}else{throw 'Unexpected service'} }
function Wait-Redis { $script:check.redisWaits++ }
function Wait-Backend { $script:check.waits++ }
function Verify { $script:check.verifies++;if($script:check.fail){throw 'Simulated persistence failure'};@{status='PASS'} }
foreach($case in @('NoDependent','StoppedBackend','RunningBackend','ForeignDependent','VerifyFailure','RedisStoppedOnFailure')) {
    $dependencies=switch($case){
        'StoppedBackend' { [pscustomobject]@{Name='WebLensBackend';Status='Stopped'} }
        'RunningBackend' { [pscustomobject]@{Name='WebLensBackend';Status='Running'} }
        'VerifyFailure' { [pscustomobject]@{Name='WebLensBackend';Status='Running'} }
        'RedisStoppedOnFailure' { [pscustomobject]@{Name='WebLensBackend';Status='Running'} }
        'ForeignDependent' { [pscustomobject]@{Name='OtherApp';Status='Running'} }
    }
    $script:check=@{dependencies=@($dependencies);stops=0;starts=0;waits=0;verifies=0;fail=($case -in @('VerifyFailure','RedisStoppedOnFailure'));redisStopped=($case -eq 'RedisStoppedOnFailure');redisStarts=0;redisWaits=0}
    $failed=$false
    try{& $body|Out-Null}catch{$failed=$true}
    $expectedFailure=$case -in @('ForeignDependent','VerifyFailure','RedisStoppedOnFailure')
    $expectedRestart=if($case -in @('RunningBackend','VerifyFailure','RedisStoppedOnFailure')){1}else{0}
    if($failed -ne $expectedFailure -or $check.stops -ne $expectedRestart -or $check.starts -ne $expectedRestart){throw "$case maintenance lifecycle failed"}
    if($case -eq 'ForeignDependent' -and ($check.waits -or $check.verifies)){throw 'Foreign dependency caused maintenance'}
    if($case -ne 'ForeignDependent' -and ($check.waits -ne 1 -or $check.verifies -ne 1)){throw 'Verification or recovery readiness was skipped'}
    if($case -eq 'RedisStoppedOnFailure' -and ($check.redisStarts -ne 1 -or $check.redisWaits -ne 1)){throw 'Redis service recovery was skipped'}
    "PASS $case"
}
Remove-Variable check -Scope Script
