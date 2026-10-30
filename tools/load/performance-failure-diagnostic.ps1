function New-PerformanceFailureDiagnostic {
    param([Management.Automation.ErrorRecord] $ErrorRecord, [string] $Stage)
    $types = @()
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception -and $types.Count -lt 8) {
        $types += $exception.GetType().FullName
        $exception = $exception.InnerException
    }
    $data = $ErrorRecord.Exception.Data
    # Preserve useful context without copying exception messages, bodies or credentials.
    [ordered]@{
        timestampUtc = [DateTime]::UtcNow.ToString('o')
        stage = $Stage
        exceptionTypes = $types
        script = [IO.Path]::GetFileName($ErrorRecord.InvocationInfo.ScriptName)
        line = $ErrorRecord.InvocationInfo.ScriptLineNumber
        command = $ErrorRecord.InvocationInfo.MyCommand.Name
        httpStatus = if ($data['httpStatus'] -is [int]) { $data['httpStatus'] } else { $null }
        errorCode = if ([string]$data['errorCode'] -cmatch '^[A-Z0-9_]{1,64}$') { [string]$data['errorCode'] } else { $null }
        correlationId = if ([string]$data['correlationId'] -match '^[0-9a-f-]{36}$') { [string]$data['correlationId'] } else { $null }
    }
}
