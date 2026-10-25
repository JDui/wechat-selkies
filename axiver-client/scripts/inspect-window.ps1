param([Parameter(Mandatory=$true)][int]$TargetProcessId, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public class ClientWindowProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int max);
  public static string Title(IntPtr h) { var b=new StringBuilder(256); GetWindowText(h,b,256); return b.ToString(); }
  public static string ClassName(IntPtr h) { var b=new StringBuilder(256); GetClassName(h,b,256); return b.ToString(); }
  public static IntPtr[] Visible(int pid) {
    var found = new List<IntPtr>();
    EnumWindows((h,p)=> { uint id; GetWindowThreadProcessId(h,out id);
      if (id==pid && IsWindowVisible(h)) found.Add(h); return true; },IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$taskWindows = @([ClientWindowProbe]::Visible($TargetProcessId))
$taskDetails = @($taskWindows | ForEach-Object {
    $taskBounds = New-Object ClientWindowProbe+Rect
    [void][ClientWindowProbe]::GetWindowRect($_, [ref]$taskBounds)
    [pscustomobject]@{Handle=$_.ToInt64();Title=[ClientWindowProbe]::Title($_);Class=[ClientWindowProbe]::ClassName($_);Width=$taskBounds.Right-$taskBounds.Left;Height=$taskBounds.Bottom-$taskBounds.Top}
})
if ($OutputPath -and $taskWindows.Count -gt 0) {
    $taskHandle = $taskWindows[0]
    $taskRect = New-Object ClientWindowProbe+Rect
    [void][ClientWindowProbe]::GetWindowRect($taskHandle, [ref]$taskRect)
    $taskBitmap = New-Object System.Drawing.Bitmap(($taskRect.Right-$taskRect.Left),($taskRect.Bottom-$taskRect.Top))
    $taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
    $taskDc = $taskGraphics.GetHdc()
    try { [void][ClientWindowProbe]::PrintWindow($taskHandle,$taskDc,2) }
    finally { $taskGraphics.ReleaseHdc($taskDc) }
    $taskBitmap.Save($OutputPath,[System.Drawing.Imaging.ImageFormat]::Png)
    $taskGraphics.Dispose()
    $taskBitmap.Dispose()
}
# Tao's 16x16 thread event target is runtime infrastructure, not an app panel.
$taskAppWindows = @($taskDetails | Where-Object { $_.Class -ne 'Tao Thread Event Target' })
[pscustomobject]@{ VisibleNativeWindows=$taskAppWindows.Count; InfrastructureWindows=$taskDetails.Count-$taskAppWindows.Count; Windows=$taskDetails } | ConvertTo-Json -Compress -Depth 4
