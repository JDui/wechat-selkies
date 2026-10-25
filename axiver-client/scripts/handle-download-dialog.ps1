param([Parameter(Mandatory=$true)][int]$TargetProcessId, [string]$Destination, [switch]$Cancel)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SaveDialogProbe {
  public delegate bool EnumProc(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn,IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumProc fn,IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h,int id);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder b,int max);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool SetWindowText(IntPtr h,string value);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h,uint message,IntPtr w,string text);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
  public static IntPtr Find(int pid) {IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);var b=new StringBuilder(128);GetClassName(h,b,128);if(id==pid&&b.ToString()=="#32770"){found=h;return false;}return true;},IntPtr.Zero);return found;}
  public static bool SetName(IntPtr dialog,string path) {Rect bounds;GetWindowRect(dialog,out bounds);IntPtr edit=IntPtr.Zero;int bottom=-999999;EnumChildWindows(dialog,(h,p)=>{var b=new StringBuilder(128);GetClassName(h,b,128);if(b.ToString()=="Edit"){Rect rect;GetWindowRect(h,out rect);if(rect.Top>bottom && rect.Top>bounds.Bottom-180){bottom=rect.Top;edit=h;}}return true;},IntPtr.Zero);return edit!=IntPtr.Zero && SendMessage(edit,0x000C,IntPtr.Zero,path)!=IntPtr.Zero;}
  public static bool Press(IntPtr dialog,int id) {var button=GetDlgItem(dialog,id);return button!=IntPtr.Zero&&PostMessage(button,0x00F5,IntPtr.Zero,IntPtr.Zero);}
}
'@
$taskDeadline=(Get-Date).AddSeconds(10)
$taskHandle=[IntPtr]::Zero
while((Get-Date) -lt $taskDeadline -and $taskHandle -eq [IntPtr]::Zero){$taskHandle=[SaveDialogProbe]::Find($TargetProcessId);if($taskHandle -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 100}}
if($taskHandle -eq [IntPtr]::Zero){throw 'The isolated client did not show a native save dialog.'}
if(-not $Cancel){
  $taskSet=$false
  while((Get-Date) -lt $taskDeadline -and -not $taskSet){$taskSet=[SaveDialogProbe]::SetName($taskHandle,$Destination);if(-not $taskSet){Start-Sleep -Milliseconds 100}}
  if(-not $taskSet){throw 'Native file-name Edit control was not ready.'}
}
if(-not [SaveDialogProbe]::Press($taskHandle,$(if($Cancel){2}else{1}))){throw 'Native save/cancel button was not found.'}
[pscustomobject]@{NativeDialogHandled=$true;Cancelled=[bool]$Cancel;Destination=$Destination}|ConvertTo-Json -Compress
