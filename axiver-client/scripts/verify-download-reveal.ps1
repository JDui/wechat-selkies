param([Parameter(Mandatory=$true)][string]$FolderPath,[Parameter(Mandatory=$true)][string]$FileName)
$ErrorActionPreference='Stop'
$taskShell=New-Object -ComObject Shell.Application
$taskDeadline=(Get-Date).AddSeconds(10)
$taskVerified=$false
while((Get-Date) -lt $taskDeadline -and -not $taskVerified){
    foreach($taskWindow in @($taskShell.Windows())){
        try {
            if(-not [StringComparer]::OrdinalIgnoreCase.Equals($taskWindow.Document.Folder.Self.Path,$FolderPath)){continue}
            $taskSelection=$taskWindow.Document.SelectedItems()
            for($taskIndex=0;$taskIndex -lt $taskSelection.Count;$taskIndex++){
                if([IO.Path]::GetFileName($taskSelection.Item($taskIndex).Path) -eq $FileName){
                    $taskVerified=$true
                    # Close only this test's exact generated folder window.
                    $taskWindow.Quit()
                    break
                }
            }
        }catch{}
    }
    if(-not $taskVerified){Start-Sleep -Milliseconds 150}
}
if(-not $taskVerified){throw 'The generated download was not selected in its Explorer folder.'}
[pscustomobject]@{ExplorerSelectedExpectedFile=$true}|ConvertTo-Json -Compress
