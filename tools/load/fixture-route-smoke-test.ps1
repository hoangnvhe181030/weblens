$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot 'manage-fixture-route-windows.ps1'
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$null,[ref]$errors)
if($errors.Count){throw 'Fixture route script parse failed'}
foreach($name in @('Get-HttpResponse','Get-JsonHealth','Test-PublicPage','Test-PublicIsolation')){
 $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false)
 if(-not $function){throw 'Fixture verification helper missing'}
 . ([ScriptBlock]::Create($function.Extent.Text))
}
function curl.exe { $global:LASTEXITCODE=$script:exitCode; $script:body; $script:status }
$publicPageUrl='https://jobnext.top/__weblens-load/page/999'
$outsideUrls=@('https://jobnext.top/__fixture/health','https://jobnext.top/__weblens-load-other/page/1')
$script:exitCode=0;$script:status='200';$script:body='{"status":"UP"}'
if((Get-JsonHealth 'http://127.0.0.1/health').status -ne 'UP'){throw 'JSON health rejected'}
$script:body='<html>SPA</html>'
if($null -ne (Get-JsonHealth 'http://127.0.0.1/health') -or (Test-PublicPage)){throw 'SPA accepted as fixture'}
if(-not (Test-PublicIsolation)){throw 'Ordinary SPA outside fixture rejected'}
$script:body='<h1>Fixture page 999</h1>'
if(-not (Test-PublicPage) -or (Test-PublicIsolation)){throw 'Leaf or isolation check failed'}
$script:status='503';$script:body='{"status":"UP"}'
if($null -ne (Get-JsonHealth 'http://127.0.0.1/health') -or (Test-PublicIsolation)){throw 'HTTP failure accepted'}
$script:status='404';$script:body='Not found'
if(-not (Test-PublicIsolation)){throw 'Outside 404 rejected'}
$script:exitCode=28
if($null -ne (Get-HttpResponse $publicPageUrl) -or (Test-PublicIsolation)){throw 'Transport failure accepted'}
'PASS fixture curl parsing, JSON health, SPA refusal, leaf, isolation, 404 and timeout'
