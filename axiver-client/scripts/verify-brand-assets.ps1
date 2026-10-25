param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BrandResourceProbe {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern uint ExtractIconEx(string path, int index, IntPtr[] large, IntPtr[] small, uint count);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
'@
$brandLarge=New-Object IntPtr[] 1
$brandSmall=New-Object IntPtr[] 1
$brandCount=[BrandResourceProbe]::ExtractIconEx((Resolve-Path -LiteralPath $Executable).Path,0,$brandLarge,$brandSmall,1)
if($brandCount -lt 1){throw 'EXE has no icon resource'}
$brandNative=[System.Drawing.Icon]::FromHandle($brandLarge[0])
$brandActual=$brandNative.ToBitmap()
$brandExpected=New-Object System.Drawing.Bitmap((Join-Path $PSScriptRoot '../icons/32x32.png'))
try {
    $brandActual.Save($OutputPath,[System.Drawing.Imaging.ImageFormat]::Png)
    $brandCompared=0;$brandMatching=0
    for($brandY=0;$brandY -lt 32;$brandY++){
        for($brandX=0;$brandX -lt 32;$brandX++){
            $brandReference=$brandExpected.GetPixel($brandX,$brandY)
            if($brandReference.A -lt 250){continue}
            $brandPixel=$brandActual.GetPixel($brandX,$brandY)
            $brandCompared++
            if([Math]::Abs([int]$brandPixel.R-$brandReference.R) -le 3 -and [Math]::Abs([int]$brandPixel.G-$brandReference.G) -le 3 -and [Math]::Abs([int]$brandPixel.B-$brandReference.B) -le 3){$brandMatching++}
        }
    }
    $brandMatches=$brandCompared -gt 0 -and $brandMatching/$brandCompared -gt .99
    [pscustomobject]@{Executable=(Resolve-Path -LiteralPath $Executable).Path;ResourceMatchesBrandPng=$brandMatches;ComparedPixels=$brandCompared;MatchingPixels=$brandMatching;IconPreview=$OutputPath} | ConvertTo-Json -Compress
    if(-not $brandMatches){exit 1}
} finally {
    $brandExpected.Dispose();$brandActual.Dispose();$brandNative.Dispose()
    [void][BrandResourceProbe]::DestroyIcon($brandLarge[0]);[void][BrandResourceProbe]::DestroyIcon($brandSmall[0])
}
