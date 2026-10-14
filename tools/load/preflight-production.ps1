[CmdletBinding()]
param(
    [string] $Email = 'weblens-load@jobnext.top',
    [string] $BaseUrl = 'https://jobnext.top',
    [string] $TargetUrl = 'https://jobnext.top/__weblens-load/page/999',
    [string] $ControlPlaneHealthUrl = 'http://127.0.0.1:8080/actuator/health',
    [string] $CrawlerHealthUrl = 'http://127.0.0.1:8081/health/ready',
    [string] $CaptureHealthUrl = 'http://127.0.0.1:8082/health/ready',
    [ValidateRange(30, 900)]
    [int] $TimeoutSeconds = 300,
    [string] $OutputDirectory = 'C:\ProgramData\WebLens\performance-fixture\runtime',
    [switch] $ResumeLatest,
    [switch] $AllowLoopbackForSmoke
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$baseUri = [Uri]$BaseUrl
$targetUri = [Uri]$TargetUrl
$controlHealthUri = [Uri]$ControlPlaneHealthUrl
$crawlerHealthUri = [Uri]$CrawlerHealthUrl
$captureHealthUri = [Uri]$CaptureHealthUrl
$ownedProductionTarget = $baseUri.Scheme -eq 'https' -and $baseUri.Host -eq 'jobnext.top' -and
    $baseUri.AbsolutePath -eq '/' -and $targetUri.Scheme -eq 'https' -and
    $targetUri.Host -eq 'jobnext.top' -and $targetUri.AbsolutePath -eq '/__weblens-load/page/999' -and
    $controlHealthUri.AbsoluteUri -eq 'http://127.0.0.1:8080/actuator/health' -and
    $crawlerHealthUri.AbsoluteUri -eq 'http://127.0.0.1:8081/health/ready' -and
    $captureHealthUri.AbsoluteUri -eq 'http://127.0.0.1:8082/health/ready'
$loopbackSmokeTarget = $AllowLoopbackForSmoke -and $baseUri.IsLoopback -and $targetUri.IsLoopback -and
    $baseUri.Scheme -eq $targetUri.Scheme -and $baseUri.Authority -eq $targetUri.Authority -and
    $targetUri.AbsolutePath -eq '/__weblens-load/page/999' -and $controlHealthUri.IsLoopback -and
    $crawlerHealthUri.IsLoopback -and $captureHealthUri.IsLoopback
if (-not $ownedProductionTarget -and -not $loopbackSmokeTarget) {
    throw 'Preflight only accepts the owned production fixture or an explicit loopback smoke target.'
}
$terminalScans = @('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')
$terminalCaptures = @('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(15)
$token = $null
$password = $null
$startedAt = [DateTime]::UtcNow

function Invoke-WebLens {
    param(
        [Parameter(Mandatory)][string] $Method,
        [Parameter(Mandatory)][string] $Path,
        [object] $Body,
        [hashtable] $Headers = @{},
        [switch] $Bytes
    )
    $request = [Net.Http.HttpRequestMessage]::new(
        [Net.Http.HttpMethod]::new($Method),
        [Uri]::new(([Uri]$BaseUrl), $Path)
    )
    try {
        $request.Headers.Accept.ParseAdd($(if ($Bytes) { 'image/jpeg' } else { 'application/json' }))
        if ($null -ne $token) { $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token) }
        foreach ($entry in $Headers.GetEnumerator()) { [void]$request.Headers.TryAddWithoutValidation($entry.Key, $entry.Value) }
        if ($null -ne $Body) {
            $json = $Body | ConvertTo-Json -Depth 10 -Compress
            $request.Content = [Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $content = if ($Bytes) {
            $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        } else {
            $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
        [pscustomobject]@{
            Status = [int]$response.StatusCode
            ContentType = $response.Content.Headers.ContentType.MediaType
            Body = if ($Bytes) { $content } elseif ([string]::IsNullOrWhiteSpace($content)) { $null } else {
                try { $content | ConvertFrom-Json } catch { $content }
            }
        }
    } finally {
        $request.Dispose()
    }
}

function Require-Status($Response, [int[]] $Expected, [string] $Action) {
    if ($Response.Status -notin $Expected) {
        $code = if ($Response.Body -is [string]) { $null } else { $Response.Body.code }
        throw "$Action failed: HTTP $($Response.Status), code=$code"
    }
    return $Response.Body
}

function Wait-Terminal([string] $Path, [string[]] $Terminal, [string] $Label) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $response = Invoke-WebLens -Method GET -Path $Path
        $body = Require-Status $response @(200) "Read $Label"
        if ($body.status -in $Terminal) { return $body }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Label did not reach a terminal state within $TimeoutSeconds seconds."
}

function Wait-ScanPage([string] $ScanId) {
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 180))
    do {
        $response = Invoke-WebLens -Method GET -Path "/api/v1/scans/$ScanId/pages?limit=10"
        if ($response.Status -eq 200 -and $response.Body.fresh -and @($response.Body.items).Count -gt 0) {
            return $response.Body
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Scan report did not become fresh with at least one page.'
}

function Get-Sha256([byte[]] $Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($Value))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

try {
    $controlHealth = Require-Status (Invoke-WebLens -Method GET -Path $ControlPlaneHealthUrl) @(200) 'Control Plane health'
    $crawlerHealth = Require-Status (Invoke-WebLens -Method GET -Path $CrawlerHealthUrl) @(200) 'Crawler health'
    $captureHealth = Require-Status (Invoke-WebLens -Method GET -Path $CaptureHealthUrl) @(200) 'Capture health'
    if ($controlHealth.status -ne 'UP' -or $crawlerHealth.status -ne 'UP' -or $captureHealth.status -ne 'UP') {
        throw 'One or more WebLens services are not UP.'
    }

    $fixture = Invoke-WebLens -Method GET -Path '/__weblens-load/__fixture/health'
    $fixtureBody = Require-Status $fixture @(200) 'Fixture health'
    if ($fixtureBody.status -ne 'UP' -or $fixtureBody.pageCount -lt 1000) { throw 'Fixture configuration is invalid.' }

    if ($env:WEBLENS_LOAD_PASSWORD) {
        $password = $env:WEBLENS_LOAD_PASSWORD
    } else {
        $securePassword = Read-Host 'Benchmark account password (hidden)' -AsSecureString
        $credential = [PSCredential]::new($Email, $securePassword)
        $password = $credential.GetNetworkCredential().Password
    }
    if ([Text.Encoding]::UTF8.GetByteCount($password) -lt 12 -or [Text.Encoding]::UTF8.GetByteCount($password) -gt 72) {
        throw 'The benchmark password must be between 12 and 72 UTF-8 bytes.'
    }

    $registration = Invoke-WebLens -Method POST -Path '/api/v1/auth/registrations' -Body @{
        email = $Email
        password = $password
        displayName = 'WebLens Load Test'
    }
    if ($registration.Status -eq 201) {
        $session = $registration.Body
        $identityCreated = $true
    } elseif ($registration.Status -eq 409) {
        $login = Invoke-WebLens -Method POST -Path '/api/v1/auth/sessions' -Body @{
            email = $Email
            password = $password
        }
        $session = Require-Status $login @(200) 'Benchmark login'
        $identityCreated = $false
    } else {
        [void](Require-Status $registration @(201, 409) 'Benchmark registration')
    }
    $token = $session.accessToken
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'Authentication response has no access token.' }

    $listed = Invoke-WebLens -Method GET -Path '/api/v1/websites?page=0&size=100&status=ACTIVE&sort=updatedAt,desc'
    $websites = Require-Status $listed @(200) 'List benchmark websites'
    $website = @($websites.items) | Where-Object { $_.canonicalUrl -eq $TargetUrl } | Select-Object -First 1
    if ($null -eq $website) {
        $createdWebsite = Invoke-WebLens -Method POST -Path '/api/v1/websites' -Body @{
            name = 'WebLens one-page performance preflight'
            url = $TargetUrl
        }
        $website = Require-Status $createdWebsite @(201) 'Create benchmark website'
    }

    $scanReused = $false
    if ($ResumeLatest) {
        if ($null -eq $website.latestScan -or [string]::IsNullOrWhiteSpace($website.latestScan.id)) {
            throw 'The benchmark website has no latest scan to resume.'
        }
        $scan = Wait-Terminal "/api/v1/scans/$($website.latestScan.id)" $terminalScans 'scan'
        $scanDurationMs = if ($null -ne $scan.durationMs) { [long]$scan.durationMs } else { 0 }
        $scanReused = $true
    } else {
        $scanStart = [DateTime]::UtcNow
        $scanResponse = Invoke-WebLens -Method POST -Path "/api/v1/websites/$($website.id)/scans" -Headers @{
            'Idempotency-Key' = [Guid]::NewGuid().ToString()
        }
        $scanCreated = Require-Status $scanResponse @(202) 'Create one-page scan'
        $scan = Wait-Terminal "/api/v1/scans/$($scanCreated.id)" $terminalScans 'scan'
        $scanDurationMs = [long]([DateTime]::UtcNow - $scanStart).TotalMilliseconds
    }
    if ($scan.status -notin @('COMPLETED', 'PARTIAL_SUCCESS')) {
        throw "Scan ended with status $($scan.status), code=$($scan.terminalReason.code)"
    }

    $report = Wait-ScanPage $scan.id
    $page = @($report.items) | Where-Object { $_.url -eq $TargetUrl } | Select-Object -First 1
    if ($null -eq $page -or $page.statusCode -ne 200 -or $page.outcome -ne 'success') {
        throw 'The expected successful leaf page was not found in the scan report.'
    }

    $captureReused = $false
    if ($ResumeLatest) {
        $latestCapture = Invoke-WebLens -Method GET -Path "/api/v1/scans/$($scan.id)/scan-pages/$($page.id)/captures/latest-ready"
        $capture = Require-Status $latestCapture @(200) 'Read latest completed capture'
        $captureDurationMs = if ($null -ne $capture.startedAt -and $null -ne $capture.finishedAt) {
            [long](([DateTime]$capture.finishedAt - [DateTime]$capture.startedAt).TotalMilliseconds)
        } else { 0 }
        $captureReused = $true
    } else {
        $captureStart = [DateTime]::UtcNow
        $captureResponse = Invoke-WebLens -Method POST -Path "/api/v1/scan-pages/$($page.id)/captures" -Headers @{
            'Idempotency-Key' = [Guid]::NewGuid().ToString()
        }
        $captureCreated = Require-Status $captureResponse @(202) 'Create page capture'
        $capture = Wait-Terminal "/api/v1/captures/$($captureCreated.id)" $terminalCaptures 'capture'
        $captureDurationMs = [long]([DateTime]::UtcNow - $captureStart).TotalMilliseconds
    }
    if ($capture.status -notin @('COMPLETED', 'PARTIAL_SUCCESS')) {
        throw "Capture ended with status $($capture.status), code=$($capture.terminalCode)"
    }

    $snapshotResponse = Invoke-WebLens -Method GET -Path "/api/v1/captures/$($capture.id)/snapshot"
    $snapshot = Require-Status $snapshotResponse @(200) 'Read capture snapshot'
    if ($snapshot.captureRequestId -ne $capture.id -or $snapshot.scanPageId -ne $page.id) {
        throw 'Capture snapshot identity does not match the requested capture/page.'
    }

    $screenshotResponse = Invoke-WebLens -Method GET -Path "/api/v1/captures/$($capture.id)/artifacts/screenshot" -Bytes
    [byte[]]$screenshot = Require-Status $screenshotResponse @(200) 'Read capture screenshot'
    if ($screenshotResponse.ContentType -ne 'image/jpeg' -or $screenshot.Length -lt 3 -or
        $screenshot[0] -ne 0xff -or $screenshot[1] -ne 0xd8 -or $screenshot[2] -ne 0xff) {
        throw 'Capture screenshot is not a valid JPEG artifact.'
    }

    $result = [ordered]@{
        schemaVersion = 1
        outcome = 'COMPLETED'
        startedAt = $startedAt.ToString('o')
        finishedAt = [DateTime]::UtcNow.ToString('o')
        environment = [ordered]@{
            baseUrl = $BaseUrl
            targetUrl = $TargetUrl
            fixturePages = [int]$fixtureBody.pageCount
            generator = [Environment]::MachineName
            services = [ordered]@{ controlPlane = 'UP'; crawler = 'UP'; capture = 'UP' }
        }
        identity = [ordered]@{ id = $session.user.id; created = $identityCreated }
        website = [ordered]@{ id = $website.id; canonicalUrl = $website.canonicalUrl }
        scan = [ordered]@{
            id = $scan.id
            status = $scan.status
            reused = $scanReused
            observedDurationMs = $scanDurationMs
            progress = $scan.progress
            effectiveConfig = $scan.effectiveConfig
            reportFresh = [bool]$report.fresh
            reportSummary = $report.summary
        }
        page = [ordered]@{
            id = $page.id
            url = $page.url
            statusCode = $page.statusCode
            outcome = $page.outcome
            responseTimeMs = $page.responseTimeMs
            responseBytes = $page.responseBytes
        }
        capture = [ordered]@{
            id = $capture.id
            status = $capture.status
            reused = $captureReused
            observedDurationMs = $captureDurationMs
            objectCount = $capture.objectCount
            totalObjectBytes = $capture.totalObjectBytes
            browserVersion = $snapshot.browserVersion
            finalUrl = $snapshot.finalUrl
            resourceCount = $snapshot.resourceCount
            capturedResourceCount = $snapshot.capturedResourceCount
            screenshotBytes = $screenshot.Length
            screenshotSha256 = Get-Sha256 $screenshot
            reconstruction = $snapshot.reconstruction
        }
    }

    [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
    $output = Join-Path $OutputDirectory ("preflight-{0:yyyyMMddTHHmmssZ}.json" -f [DateTime]::UtcNow)
    [IO.File]::WriteAllText(
        $output,
        ($result | ConvertTo-Json -Depth 20),
        [Text.UTF8Encoding]::new($false)
    )
    [pscustomobject]@{
        outcome = $result.outcome
        output = $output
        identityCreated = $identityCreated
        websiteId = $website.id
        scanId = $scan.id
        scanStatus = $scan.status
        scanReused = $scanReused
        processedPages = $scan.progress.processed
        pageId = $page.id
        captureId = $capture.id
        captureStatus = $capture.status
        captureReused = $captureReused
        screenshotBytes = $screenshot.Length
    } | ConvertTo-Json -Compress
} finally {
    $token = $null
    $password = $null
    Remove-Item Env:WEBLENS_LOAD_PASSWORD -ErrorAction SilentlyContinue
    $client.Dispose()
}
