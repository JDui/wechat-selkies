param(
    [string]$InputDir = "diagnostics/overnight",
    [int]$WindowSize = 7
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path $InputDir)) {
    throw "Input directory not found: $InputDir"
}

$summaryFiles = @(Get-ChildItem -Path $InputDir -Recurse -Filter "summary.json" |
    Sort-Object FullName)

if ($summaryFiles.Count -eq 0) {
    throw "No summary.json files found in $InputDir"
}

$entries = @()
foreach ($file in $summaryFiles) {
    $data = Get-Content -Raw -Path $file.FullName | ConvertFrom-Json
    $entries += [PSCustomObject]@{
        file = $file.FullName
        timestamp = [DateTime]$data.timestamp
        paused = [bool]$data.state.paused
        running = [bool]$data.state.running
        restartCount = [int]$data.state.restartCount
        lifecycleEventCount = [int]$data.lifecycleEventCount
        lifecycleEventsCollected = ($null -ne $data.PSObject.Properties['lifecycleEventsCollected']) -and `
            ($data.lifecycleEventsCollected -eq $true)
        wechatProcessDetected = $data.wechatProcessDetected
        wechatLoginState = if ($null -ne $data.PSObject.Properties['wechatLoginState']) {
            [string]$data.wechatLoginState
        } else {
            "unknown"
        }
        verdict = [string]$data.verdict
    }
}

$entries = @($entries | Sort-Object timestamp)
$window = @($entries | Select-Object -Last $WindowSize)

$restartCountIncreased = $false
for ($i = 1; $i -lt $window.Count; $i++) {
    if ($window[$i].restartCount -gt $window[$i - 1].restartCount) {
        $restartCountIncreased = $true
        break
    }
}

$notRunningCount = @($window | Where-Object { -not $_.running }).Count
$pausedCount = @($window | Where-Object { $_.paused }).Count
$lifecycleIssueCount = @($window | Where-Object { $_.lifecycleEventCount -gt 0 }).Count
$lifecycleUnknownCount = @($window | Where-Object { -not $_.lifecycleEventsCollected }).Count
$wechatProcessMissingCount = @($window | Where-Object { $_.wechatProcessDetected -eq $false }).Count
$wechatProcessUnknownCount = @($window | Where-Object { $null -eq $_.wechatProcessDetected }).Count
$wechatLoginUnknownCount = @($window | Where-Object { $_.wechatLoginState -eq "unknown" }).Count
$unknownVerdictCount = @($window | Where-Object { $_.verdict -eq "unknown" }).Count

$acceptancePass = ($window.Count -ge $WindowSize) -and `
    ($notRunningCount -eq 0) -and `
    ($pausedCount -eq 0) -and `
    ($lifecycleIssueCount -eq 0) -and `
    ($lifecycleUnknownCount -eq 0) -and `
    (-not $restartCountIncreased)

$report = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    inputDir = (Resolve-Path $InputDir).Path
    windowSize = $WindowSize
    sampleCount = $window.Count
    acceptance = [ordered]@{
        pass = $acceptancePass
        criteria = "running=true, paused=false, lifecycle events collected without interruptions, restartCount not increasing across the window; login state is evaluated separately"
    }
    counts = [ordered]@{
        notRunning = $notRunningCount
        paused = $pausedCount
        lifecycleIssues = $lifecycleIssueCount
        lifecycleUnknown = $lifecycleUnknownCount
        wechatProcessMissing = $wechatProcessMissingCount
        wechatProcessUnknown = $wechatProcessUnknownCount
        wechatLoginUnknown = $wechatLoginUnknownCount
        unknownVerdicts = $unknownVerdictCount
        restartCountIncreased = $restartCountIncreased
    }
    latestVerdicts = @($window | ForEach-Object {
        [ordered]@{
            timestamp = $_.timestamp.ToString("o")
            restartCount = $_.restartCount
            verdict = $_.verdict
            file = $_.file
        }
    })
}

$reportJson = $report | ConvertTo-Json -Depth 6
$reportPath = Join-Path $InputDir "seven-night-report.json"
Set-Content -Path $reportPath -Value $reportJson -Encoding UTF8

Write-Output "Report generated: $reportPath"
Write-Output "Acceptance pass: $acceptancePass"
