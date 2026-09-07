#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateSet('register', 'status', 'run', 'disable', 'remove')]
    [string]$Action = 'register',

    [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$runAction = -not $LibraryOnly

$script:TaskName = 'Engineering Bridge Secure MCP Tunnel'
$script:ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:LauncherPath = (Resolve-Path (Join-Path $PSScriptRoot 'start-tunnel-runtime.ps1')).Path
$script:HiddenLauncherPath = (Resolve-Path (Join-Path $PSScriptRoot 'start-tunnel-runtime-hidden.vbs')).Path
$script:WindowsScriptHostPath = Join-Path ([Environment]::GetFolderPath('Windows')) 'System32\wscript.exe'
$script:PowerShell7Path = 'C:\Program Files (x86)\PowerShell\7\pwsh.exe'

$launcher = Join-Path $PSScriptRoot 'start-tunnel-runtime.ps1'
. $launcher -LibraryOnly

function Get-CurrentTaskUser {
    return [Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function New-TunnelRuntimeTaskSpec {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Launcher,
        [Parameter(Mandatory)][string]$HiddenLauncher,
        [Parameter(Mandatory)][string]$ScriptHostPath,
        [Parameter(Mandatory)][string]$PowerShellPath,
        [Parameter(Mandatory)][string]$User
    )

    if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) {
        throw "PowerShell 7 executable is missing: $PowerShellPath"
    }
    if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
        throw "Tunnel launcher is missing: $Launcher"
    }
    if (-not (Test-Path -LiteralPath $HiddenLauncher -PathType Leaf)) {
        throw "Hidden launcher is missing: $HiddenLauncher"
    }
    if (-not (Test-Path -LiteralPath $ScriptHostPath -PathType Leaf)) {
        throw "Windows Script Host is missing: $ScriptHostPath"
    }

    return [pscustomobject]@{
        TaskName          = $script:TaskName
        User              = $User
        Trigger           = 'AtLogOn'
        LogonType         = 'Interactive'
        RunAsSystem       = $false
        Hidden            = $true
        MultipleInstances = 'IgnoreNew'
        Execute           = $ScriptHostPath
        Arguments         = '//B //NoLogo "{0}" "{1}" "{2}"' -f $HiddenLauncher, $PowerShellPath, $Launcher
        WorkingDirectory  = $Root
    }
}

function Assert-TaskSecretReady {
    $secretPath = Get-RuntimeSecretPath
    Assert-RuntimeSecretFile -Path $secretPath | Out-Null
    return $secretPath
}

function Register-TunnelRuntimeTask {
    $user = Get-CurrentTaskUser
    $secretPath = Assert-TaskSecretReady
    $spec = New-TunnelRuntimeTaskSpec `
        -Root $script:ProjectRoot `
        -Launcher $script:LauncherPath `
        -HiddenLauncher $script:HiddenLauncherPath `
        -ScriptHostPath $script:WindowsScriptHostPath `
        -PowerShellPath $script:PowerShell7Path `
        -User $user

    $action = New-ScheduledTaskAction `
        -Execute $spec.Execute `
        -Argument $spec.Arguments `
        -WorkingDirectory $spec.WorkingDirectory
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $spec.User
    $principal = New-ScheduledTaskPrincipal `
        -UserId $spec.User `
        -LogonType Interactive `
        -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -Hidden `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask `
        -TaskName $spec.TaskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description 'Starts the Engineering Bridge Secure MCP Tunnel for the signed-in user.' `
        -Force | Out-Null

    Write-Output 'TASK_SCHEDULER_REGISTERED=YES'
    Write-Output "TASK_NAME=$($spec.TaskName)"
    Write-Output "TASK_USER=$($spec.User)"
    Write-Output 'TASK_TRIGGER=AT_LOG_ON'
    Write-Output 'RUN_AS_SYSTEM=NO'
    Write-Output 'TASK_HIDDEN=YES'
    Write-Output 'TASK_MULTIPLE_INSTANCES=IGNORE_NEW'
    Write-Output "TASK_SECRET_REFERENCE=file:$secretPath"
    Write-Output 'SECRET_LITERAL_IN_TASK=NO'
}

function Get-TunnelRuntimeTask {
    return Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
}

function Show-TunnelRuntimeTask {
    $task = Get-TunnelRuntimeTask
    if ($null -eq $task) {
        Write-Output 'TASK_SCHEDULER_REGISTERED=NO'
        return
    }

    $info = Get-ScheduledTaskInfo -TaskName $script:TaskName
    Write-Output 'TASK_SCHEDULER_REGISTERED=YES'
    Write-Output "TASK_NAME=$script:TaskName"
    Write-Output "TASK_STATE=$($task.State)"
    Write-Output "TASK_USER=$($task.Principal.UserId)"
    Write-Output "TASK_LOGON_TYPE=$($task.Principal.LogonType)"
    Write-Output "TASK_RUN_LEVEL=$($task.Principal.RunLevel)"
    Write-Output "TASK_ACTION=$($task.Actions.Execute)"
    Write-Output "TASK_ARGUMENTS=$($task.Actions.Arguments)"
    Write-Output "TASK_LAST_RUN=$($info.LastRunTime.ToString('o'))"
    Write-Output "TASK_LAST_RESULT=$($info.LastTaskResult)"
    Write-Output 'SECRET_LITERAL_IN_TASK=NO'
}

function Invoke-TaskAction {
    switch ($Action) {
        'register' {
            Register-TunnelRuntimeTask
        }
        'status' {
            Show-TunnelRuntimeTask
        }
        'run' {
            if ($null -eq (Get-TunnelRuntimeTask)) {
                throw "Scheduled task is missing: $script:TaskName"
            }
            Start-ScheduledTask -TaskName $script:TaskName
            Write-Output 'TASK_TRIGGERED=YES'
        }
        'disable' {
            if ($null -ne (Get-TunnelRuntimeTask)) {
                Disable-ScheduledTask -TaskName $script:TaskName | Out-Null
            }
            Write-Output 'TASK_DISABLED=YES'
        }
        'remove' {
            if ($null -ne (Get-TunnelRuntimeTask)) {
                Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
            }
            Write-Output 'TASK_REMOVED=YES'
        }
    }
}

if ($runAction) {
    Invoke-TaskAction
}
