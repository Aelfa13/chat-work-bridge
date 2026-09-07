#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskScript = Join-Path $PSScriptRoot 'manage-tunnel-runtime-task.ps1'
. $taskScript -LibraryOnly

$passed = 0
function Assert-Test {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )

    if (-not $Condition) {
        throw "FAIL: $Message"
    }
    $script:passed++
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$launcher = (Resolve-Path (Join-Path $PSScriptRoot 'start-tunnel-runtime.ps1')).Path
$hiddenLauncher = (Resolve-Path (Join-Path $PSScriptRoot 'start-tunnel-runtime-hidden.vbs')).Path
$scriptHost = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\wscript.exe'
$powershell7 = 'C:\Program Files (x86)\PowerShell\7\pwsh.exe'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$spec = New-TunnelRuntimeTaskSpec `
    -Root $root `
    -Launcher $launcher `
    -HiddenLauncher $hiddenLauncher `
    -ScriptHostPath $scriptHost `
    -PowerShellPath $powershell7 `
    -User $user

Assert-Test ($spec.TaskName -eq 'Engineering Bridge Secure MCP Tunnel') 'task name is stable'
Assert-Test ($spec.User -eq $user -and $spec.User -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM')) 'task is registered for the current user, not SYSTEM'
Assert-Test ($spec.Trigger -eq 'AtLogOn') 'task trigger is current-user logon'
Assert-Test ($spec.LogonType -eq 'Interactive') 'task uses the Windows interactive logon type'
Assert-Test ($spec.RunAsSystem -eq $false -and $spec.Hidden -eq $true) 'task is hidden and not a SYSTEM task'
Assert-Test ($spec.MultipleInstances -eq 'IgnoreNew') 'duplicate task instances are ignored'
Assert-Test ($spec.Execute -eq $scriptHost) 'task uses Windows Script Host without a console'
Assert-Test ($spec.Arguments -like '*start-tunnel-runtime-hidden.vbs*') 'task uses the hidden launcher wrapper'
Assert-Test ((Get-Content -Raw $hiddenLauncher) -like '*-WindowStyle Hidden*') 'wrapper starts PowerShell without a console window'
Assert-Test ($spec.Arguments -like '*start-tunnel-runtime.ps1*') 'launcher path is passed to the wrapper'
Assert-Test ($spec.Arguments -notmatch 'CONTROL_PLANE_API_KEY|file:|api[_-]?key|tunnel_[0-9a-f]+') 'task arguments contain no secret or runtime reference'

Write-Output "TARGETED_TASK_TESTS=PASS ($passed assertions)"
