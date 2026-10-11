param(
    [string]$ContainerName = "wechat-selkies",
    [string]$Since = "",
    [string]$Until = "",
    [string]$OutputDir = "diagnostics/overnight"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Test-DockerReady {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "docker command not found."
    }

    & docker version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "docker daemon is unavailable."
    }
}

function Invoke-DockerCapture {
    param(
        [string]$TargetFile,
        [string[]]$DockerArgs,
        [switch]$AllowFailure
    )

    $result = & docker @DockerArgs 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($result | Out-String).TrimEnd()
    Set-Content -Path (Join-Path $script:RunDir $TargetFile) -Value $text -Encoding UTF8

    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "docker $($DockerArgs -join ' ') failed: $text"
    }

    return @{
        ExitCode = $exitCode
        Text = $text
    }
}

if ([string]::IsNullOrWhiteSpace($Since)) {
    $Since = (Get-Date).AddHours(-12).ToString("o")
}
if ([string]::IsNullOrWhiteSpace($Until)) {
    $Until = (Get-Date).ToString("o")
}

Test-DockerReady

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$script:RunDir = Join-Path $OutputDir $timestamp
New-Item -ItemType Directory -Path $script:RunDir -Force | Out-Null

$containerNames = & docker container ls --all --format "{{.Names}}"
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list containers."
}
if (-not ($containerNames -contains $ContainerName)) {
    throw "Container not found: $ContainerName"
}

$inspectRaw = Invoke-DockerCapture -TargetFile "inspect.json" -DockerArgs @("inspect", $ContainerName)
$inspect = $inspectRaw.Text | ConvertFrom-Json
$containerInfo = $inspect[0]
$state = $containerInfo.State

$stateLine = "{0} paused={1} running={2} restarting={3} restart_count={4}" -f `
    $state.Status, $state.Paused, $state.Running, $state.Restarting, $containerInfo.RestartCount
Set-Content -Path (Join-Path $script:RunDir "state-summary.txt") -Value $stateLine -Encoding UTF8

$eventsRaw = Invoke-DockerCapture -TargetFile "events.log" -DockerArgs @(
    "events",
    "--since", $Since,
    "--until", $Until,
    "--filter", "container=$ContainerName"
) -AllowFailure

$lifecyclePattern = "\s(pause|unpause|restart|oom|kill|die|stop|start)\s"
$lifecycleEvents = @()
if (-not [string]::IsNullOrWhiteSpace($eventsRaw.Text)) {
    $lifecycleEvents = @($eventsRaw.Text -split "`r?`n" | Where-Object { $_ -match $lifecyclePattern })
}
Set-Content -Path (Join-Path $script:RunDir "events.lifecycle.log") -Value ($lifecycleEvents -join [Environment]::NewLine) -Encoding UTF8

Invoke-DockerCapture -TargetFile "container.log" -DockerArgs @(
    "logs",
    "--since", $Since,
    $ContainerName
) -AllowFailure | Out-Null

$procRaw = Invoke-DockerCapture -TargetFile "wechat-process.txt" -DockerArgs @(
    "exec",
    $ContainerName,
    "sh",
    "-lc",
    "pgrep -af '^/usr/bin/[w]echat([[:space:]]|$)'"
) -AllowFailure

$networkRaw = Invoke-DockerCapture -TargetFile "network-check.txt" -DockerArgs @(
    "exec",
    $ContainerName,
    "sh",
    "-lc",
    "date -Is; echo PUBLIC_IP:; curl -fsS --max-time 8 ifconfig.me || true; echo; echo DNS_WEIXIN:; getent hosts weixin.qq.com || true; echo HTTPS_WEIXIN:; curl -I -sS --max-time 8 https://weixin.qq.com | head -n 5 || true"
) -AllowFailure

$wechatRunning = $null
if ($procRaw.ExitCode -eq 0) {
    $wechatRunning = -not [string]::IsNullOrWhiteSpace($procRaw.Text)
} elseif ($procRaw.ExitCode -eq 1 -and [string]::IsNullOrWhiteSpace($procRaw.Text)) {
    $wechatRunning = $false
}

$verdict = "unknown"
if (-not $state.Running -or $state.Paused -or $lifecycleEvents.Count -gt 0) {
    $verdict = "container_interruption_or_state_change"
} elseif ($wechatRunning -eq $false) {
    $verdict = "wechat_process_missing_while_container_running"
}

$summary = [ordered]@{
    timestamp = (Get-Date).ToString("o")
    container = $ContainerName
    since = $Since
    until = $Until
    state = [ordered]@{
        status = $state.Status
        paused = $state.Paused
        running = $state.Running
        restarting = $state.Restarting
        restartCount = $containerInfo.RestartCount
        startedAt = $state.StartedAt
        finishedAt = $state.FinishedAt
    }
    lifecycleEventCount = $lifecycleEvents.Count
    lifecycleEventsCollected = ($eventsRaw.ExitCode -eq 0)
    wechatProcessDetected = $wechatRunning
    wechatLoginState = "unknown"
    verdict = $verdict
    files = [ordered]@{
        inspect = "inspect.json"
        stateSummary = "state-summary.txt"
        events = "events.log"
        lifecycleEvents = "events.lifecycle.log"
        containerLog = "container.log"
        wechatProcess = "wechat-process.txt"
        networkCheck = "network-check.txt"
    }
}

$summaryJson = $summary | ConvertTo-Json -Depth 6
Set-Content -Path (Join-Path $script:RunDir "summary.json") -Value $summaryJson -Encoding UTF8

$summaryText = @(
    "container=$ContainerName"
    "window=$Since -> $Until"
    "state=$stateLine"
    "lifecycle_event_count=$($lifecycleEvents.Count)"
    "lifecycle_events_collected=$($eventsRaw.ExitCode -eq 0)"
    "wechat_process_detected=$wechatRunning"
    "wechat_login_state=unknown"
    "verdict=$verdict"
)
Set-Content -Path (Join-Path $script:RunDir "summary.txt") -Value ($summaryText -join [Environment]::NewLine) -Encoding UTF8

Write-Output "Evidence collected: $script:RunDir"
