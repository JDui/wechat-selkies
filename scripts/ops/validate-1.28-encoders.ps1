param(
    [string]$Image = "wechat-selkies:1.28",
    [switch]$IncludeVaapi,
    [switch]$KeepContainers
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-CheckedDocker {
    param([string[]]$DockerArgs)
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($DockerArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Wait-ContainerHealthyEnough {
    param([string]$Name)
    for ($i = 0; $i -lt 45; $i++) {
        & docker exec $Name /scripts/healthcheck.sh *> $null
        if ($LASTEXITCODE -eq 0) {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "container $Name did not pass /scripts/healthcheck.sh"
}

function Invoke-EncoderProbe {
    param(
        [string]$Name,
        [string]$Encoder,
        [bool]$UseCpu,
        [bool]$Transitions
    )

    $payload = @{
        displayId = "primary"
        initialClientWidth = 640
        initialClientHeight = 360
        framerate = 30
        encoder = $Encoder
        h264_crf = 30
        jpeg_quality = 40
        use_cpu = $UseCpu
        dynamic_low_latency_enabled = $true
        dynamic_low_latency_fps = 12
        dynamic_low_latency_h264_crf = 40
        dynamic_low_latency_sample_percent = 75
        dynamic_low_latency_disable_paint_over = $true
    } | ConvertTo-Json -Compress

    $script = @"
import asyncio
import base64
import json
import sys
import websockets

payload = json.loads(base64.b64decode(sys.argv[1]).decode())
transitions = sys.argv[2] == "1"

async def main():
    async with websockets.connect("ws://127.0.0.1:8082") as ws:
        await ws.send("SETTINGS," + json.dumps(payload, separators=(",", ":")))
        await asyncio.sleep(2)
        if transitions:
            await ws.send("LOW_LATENCY_STATE,1,script,12,40,75,1")
            await asyncio.sleep(3)
            await ws.send("LOW_LATENCY_STATE,0,script,12,40,75,1")
            await asyncio.sleep(3)
            await ws.send("LOW_LATENCY_STATE,1,script,12,40,75,1")
            await asyncio.sleep(3)

asyncio.run(main())
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
    $payloadEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $transitionFlag = if ($Transitions) { "1" } else { "0" }
    Invoke-CheckedDocker @(
        "exec", $Name, "/lsiopy/bin/python3", "-c",
        "import base64,sys; code=base64.b64decode(sys.argv[1]).decode(); sys.argv=[sys.argv[0], sys.argv[2], sys.argv[3]]; exec(code)",
        $encoded, $payloadEncoded, $transitionFlag
    )
}

function Assert-Log {
    param(
        [string]$Name,
        [string]$Pattern,
        [string]$Description
    )
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $logs = & docker logs $Name 2>&1 | Out-String
    }
    finally {
        $ErrorActionPreference = $oldPreference
    }
    if (($logs | Select-String -Pattern $Pattern -Quiet) -ne $true) {
        throw "$Name missing expected log: $Description"
    }
}

function Assert-NoBadLogs {
    param([string]$Name)
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $logs = & docker logs $Name 2>&1 | Out-String
    }
    finally {
        $ErrorActionPreference = $oldPreference
    }
    $bad = $logs | Select-String -Pattern "Force-recover|FATAL DECODER ERROR|Traceback|fallback|Fallback|ERROR:data_websocket" | Select-Object -First 1
    if ($bad) {
        throw "$Name found bad log line: $bad"
    }
}

function Remove-ContainerIfExists {
    param([string]$Name)
    $existing = & docker ps -aq --filter "name=^/$Name$"
    if ($existing) {
        Invoke-CheckedDocker @("rm", "-f", $Name)
    }
}

function Assert-VaapiDeviceMapping {
    param([string]$ImageName)

    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & docker run --rm --device /dev/dri:/dev/dri --entrypoint sh $ImageName -lc "test -e /dev/dri/renderD128 -o -e /dev/dri/card0 && ls -l /dev/dri" 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $oldPreference
    }

    if ($exitCode -ne 0) {
        throw @"
VAAPI validation requested, but Docker could not map a usable /dev/dri device into the container.
Run this validation on a Linux host with /dev/dri/renderD128 exposed to Docker.

Docker output:
$output
"@
    }
    Write-Host "VAAPI device mapping available:"
    Write-Host $output.Trim()
}

if ($IncludeVaapi) {
    Assert-VaapiDeviceMapping $Image
}

$cases = @(
    @{
        Name = "cpu-h264"
        Encoder = "x264enc"
        UseCpu = $true
        Transitions = $true
        Device = $false
        ExpectedMode = "Mode: H264 \(CPU\) FullFrame"
    },
    @{
        Name = "jpeg"
        Encoder = "jpeg"
        UseCpu = $true
        Transitions = $false
        Device = $false
        ExpectedMode = "Mode: JPEG"
    },
    @{
        Name = "striped"
        Encoder = "x264enc-striped"
        UseCpu = $true
        Transitions = $false
        Device = $false
        ExpectedMode = "Mode: H264 \(CPU\) Striped"
    }
)

if ($IncludeVaapi) {
    $cases += @{
        Name = "vaapi-h264"
        Encoder = "x264enc"
        UseCpu = $false
        Transitions = $true
        Device = $true
        ExpectedMode = "Mode: H264 \(VAAPI\) FullFrame"
    }
}

$completed = @()
try {
    foreach ($case in $cases) {
        $container = "wechat-selkies-validate-$($case.Name)"
        Remove-ContainerIfExists $container

        $runArgs = @(
            "run", "-d", "--name", $container,
            "-e", "AUTO_START_WECHAT=false",
            "-e", "PROCESS_WATCHDOG=false",
            "-e", "SELKIES_DYNAMIC_LOW_LATENCY=true",
            "-e", "SELKIES_DEFAULT_H264_STREAMING_MODE=true"
        )
        if ($case.Device) {
            $runArgs += @("--device", "/dev/dri:/dev/dri")
        }
        $runArgs += $Image

        Write-Host "Starting $($case.Name) probe..."
        Invoke-CheckedDocker $runArgs
        $completed += $container
        Wait-ContainerHealthyEnough $container
        Invoke-EncoderProbe -Name $container -Encoder $case.Encoder -UseCpu $case.UseCpu -Transitions $case.Transitions

        Assert-Log -Name $container -Pattern $case.ExpectedMode -Description $case.ExpectedMode
        if ($case.Transitions) {
            Assert-Log -Name $container -Pattern "Dynamic inactive frame limit enabled" -Description "inactive enabled"
            Assert-Log -Name $container -Pattern "Dynamic inactive frame limit disabled" -Description "inactive disabled"
        }
        Assert-NoBadLogs $container
        Write-Host "PASS $($case.Name)"
    }
    Write-Host "All encoder probes passed for $Image"
}
finally {
    if (-not $KeepContainers) {
        foreach ($container in $completed) {
            Remove-ContainerIfExists $container
        }
    }
}
