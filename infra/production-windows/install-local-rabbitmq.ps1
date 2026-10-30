[CmdletBinding()]
param(
    [ValidateSet('install','verify')][string]$Action='verify',
    [string]$DownloadDirectory='C:\ProgramData\WebLens\downloads'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($env:COMPUTERNAME -ne 'WIN-D1G2GS3O7J7'){throw 'Installer is pinned to the inspected WebLens VPS'}
$root='C:\ProgramData\WebLens\rabbitmq'
$erlang='C:\WebLens\runtime\erlang-28.5'
$server='C:\WebLens\runtime\rabbitmq_server-4.3.6'
$service='WebLensRabbitMQ'
$utf8=[Text.UTF8Encoding]::new($false)
function Protect([string]$Path){
    & icacls.exe $Path /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
    if($LASTEXITCODE -ne 0){throw 'RabbitMQ ACL failed'}
}
function Secret {
    $bytes=New-Object byte[] 32
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$rng.GetBytes($bytes)}finally{$rng.Dispose()}
    return ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
}
function PasswordHash([string]$Password){
    $salt=New-Object byte[] 4
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try{$rng.GetBytes($salt)}finally{$rng.Dispose()}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$hash=$sha.ComputeHash([byte[]]($salt+$utf8.GetBytes($Password)))}finally{$sha.Dispose()}
    return [Convert]::ToBase64String([byte[]]($salt+$hash))
}
function ConfigureProcess {
    $env:APPDATA=$root
    $env:ERLANG_HOME=$erlang
    $env:RABBITMQ_SERVICENAME=$service
    $env:RABBITMQ_NODENAME='weblens_rabbit@localhost'
    $env:RABBITMQ_BASE=$root
    $env:RABBITMQ_CONFIG_FILE=Join-Path $root 'rabbitmq'
    $env:RABBITMQ_MNESIA_BASE=Join-Path $root 'data'
    $env:RABBITMQ_LOG_BASE=Join-Path $root 'logs'
    $env:RABBITMQ_ENABLED_PLUGINS_FILE=Join-Path $root 'enabled_plugins'
    $env:ERL_EPMD_ADDRESS='127.0.0.1'
    $env:RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS='+S 2:2 +A 4 -kernel inet_dist_use_interface {127,0,0,1}'
    $env:RABBITMQ_CTL_ERL_ARGS='+S 1:1 +A 1 -kernel inet_dist_use_interface {127,0,0,1}'
}
function Verify {
    if((Get-Service $service).Status -ne 'Running'){throw 'RabbitMQ Windows service is not running'}
    $ready=$false
    for($i=0;$i -lt 30;$i++){
        try{
            $secrets=Get-Content -LiteralPath (Join-Path $root 'credentials.json') -Raw | ConvertFrom-Json
            $auth=[Convert]::ToBase64String($utf8.GetBytes('weblens_admin:'+$secrets.weblens_admin))
            $result=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:15672/api/health/checks/alarms' -Headers @{Authorization="Basic $auth"} -TimeoutSec 5
            if($result.StatusCode -eq 200){$ready=$true;break}
        }catch{}
        Start-Sleep -Seconds 2
    }
    if(-not $ready){throw 'RabbitMQ management health/alarms check failed'}
    $activeListeners=[Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    foreach($port in @(5672,15672,4369,25672)){
        $listeners=@($activeListeners | Where-Object Port -eq $port)
        if($listeners.Count -eq 0){throw "RabbitMQ listener missing: $port"}
        foreach($listener in $listeners){
            if(-not [Net.IPAddress]::IsLoopback($listener.Address)){throw "Non-loopback RabbitMQ listener: $port"}
        }
    }
    $queues=Invoke-RestMethod -Uri 'http://127.0.0.1:15672/api/queues/weblens' -Headers @{Authorization="Basic $auth"} -TimeoutSec 10
    foreach($name in @('weblens.scan.commands.v1','weblens.scan.dead.v1')){
        $queue=@($queues | Where-Object name -eq $name)
        if($queue.Count -ne 1 -or $queue[0].type -ne 'quorum' -or -not $queue[0].durable){throw 'RabbitMQ durable quorum topology missing'}
    }
    Write-Output 'PASS: RabbitMQ 4.3.6 service, authenticated health, quorum topology and all listeners loopback-only'
}
ConfigureProcess
if($Action -eq 'verify'){Verify;return}
if(Get-Service $service -ErrorAction SilentlyContinue){
    if((Get-CimInstance Win32_Service -Filter "Name='$service'").PathName -notlike ($erlang+'\*')){throw 'Existing RabbitMQ service uses an unexpected executable'}
    if((Get-Service $service).Status -eq 'Running'){Verify;return}
}
if(Get-Service RabbitMQ -ErrorAction SilentlyContinue){throw 'An unrelated RabbitMQ service already exists'}
foreach($port in @(5672,15672,4369,25672)){
    foreach($listener in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)){
        $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        if($port -eq 4369 -and $owner.Name -eq 'epmd.exe' -and $owner.ExecutablePath.StartsWith($erlang+'\',[StringComparison]::OrdinalIgnoreCase) -and [Net.IPAddress]::IsLoopback([Net.IPAddress]::Parse($listener.LocalAddress))){continue}
        throw "Port already occupied: $port"
    }
}
if((Get-PSDrive C).Free -lt 3GB){throw 'At least 3 GiB free disk required before RabbitMQ installation'}
$packages=@(
    @{Name='otp_win64_28.5.exe';Hash='46f56351e2e67865c6aaff83bcd0a7d97d73bea643a0531774dd9ba8fbee7dc0'},
    @{Name='rabbitmq-server-windows-4.3.6.zip';Hash='48161b084f1257edc112b24fccda378cc3e83c8e4b94984801cd6651817981f1'}
)
foreach($package in $packages){
    $path=Join-Path $DownloadDirectory $package.Name
    if((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -ne $package.Hash){throw 'RabbitMQ/Erlang package checksum failed'}
}
if(-not (Test-Path -LiteralPath (Join-Path $erlang 'bin\erl.exe'))){
    $install=Start-Process -FilePath (Join-Path $DownloadDirectory 'otp_win64_28.5.exe') -ArgumentList @('/S',('/D='+$erlang)) -WindowStyle Hidden -Wait -PassThru
    if($install.ExitCode -ne 0){throw 'Erlang installation failed'}
}
if(-not (Test-Path -LiteralPath $server)){
    Expand-Archive -LiteralPath (Join-Path $DownloadDirectory 'rabbitmq-server-windows-4.3.6.zip') -DestinationPath 'C:\WebLens\runtime'
}
New-Item -ItemType Directory -Force -Path $root,(Join-Path $root 'data'),(Join-Path $root 'logs'),(Join-Path $root 'erlang') | Out-Null
Protect $root
if(-not (Test-Path -LiteralPath (Join-Path $root 'credentials.json'))){
    $secrets=@{weblens_control=(Secret);weblens_crawler=(Secret);weblens_admin=(Secret)}
    [IO.File]::WriteAllText((Join-Path $root 'credentials.json'),($secrets | ConvertTo-Json),$utf8)
    [IO.File]::WriteAllText((Join-Path $root '.erlang.cookie'),(Secret),$utf8)
    $definitions=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\rabbitmq\definitions.json') -Raw | ConvertFrom-Json
    foreach($user in $definitions.users){$user.password_hash=PasswordHash $secrets[$user.name]}
    [IO.File]::WriteAllText((Join-Path $root 'definitions.json'),($definitions | ConvertTo-Json -Depth 20),$utf8)
}
# erlsrv supplies -home itself. OTP 28 uses APPDATA/erlang if no single home resolves.
Copy-Item -LiteralPath (Join-Path $root '.erlang.cookie') -Destination (Join-Path $root 'erlang\.erlang.cookie') -Force
$config=@'
listeners.tcp.1 = 127.0.0.1:5672
management.tcp.ip = 127.0.0.1
management.tcp.port = 15672
definitions.import_backend = local_filesystem
definitions.local.path = C:/ProgramData/WebLens/rabbitmq/definitions.json
max_message_size = 65536
vm_memory_high_watermark.absolute = 256MiB
disk_free_limit.absolute = 2GB
log.file.rotation.size = 10485760
log.file.rotation.count = 3
'@
[IO.File]::WriteAllText((Join-Path $root 'rabbitmq.conf'),$config,$utf8)
[IO.File]::WriteAllText((Join-Path $root 'enabled_plugins'),'[rabbitmq_management].',$utf8)
& (Join-Path $server 'sbin\rabbitmq-service.bat') install | Out-Null
if($LASTEXITCODE -ne 0){throw 'RabbitMQ service registration failed'}
$manager=(Get-ChildItem -LiteralPath $erlang -Directory -Filter 'erts-*' | Select-Object -First 1).FullName
# erlsrv captures these explicitly; do not rely on an interactive user's environment.
& (Join-Path $manager 'bin\erlsrv.exe') set $service -env ERL_EPMD_ADDRESS=127.0.0.1 -env "RABBITMQ_ENABLED_PLUGINS_FILE=$env:RABBITMQ_ENABLED_PLUGINS_FILE" | Out-Null
if($LASTEXITCODE -ne 0){throw 'RabbitMQ service environment configuration failed'}
Set-Service -Name $service -StartupType Automatic
Start-Service -Name $service
Verify
