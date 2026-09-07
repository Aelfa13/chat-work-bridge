#requires -Version 7.0

[CmdletBinding()]
param(
    [switch]$Rotate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'start-tunnel-runtime.ps1'
. $launcher -LibraryOnly

function Set-CurrentUserOnlyAcl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$Directory
    )

    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($entry in @($acl.Access)) {
        [void]$acl.RemoveAccessRule($entry)
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$secretPath = Get-RuntimeSecretPath
$secretDir = Split-Path -Parent $secretPath

if (Test-Path -LiteralPath $secretPath) {
    if (-not $Rotate) {
        throw "RUNTIME_SECRET_EXISTS: $secretPath. Use -Rotate only when intentionally replacing it."
    }
    if ((Get-Item -LiteralPath $secretPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "RUNTIME_SECRET_UNAVAILABLE: refusing to replace a reparse-point path: $secretPath"
    }
}

New-Item -ItemType Directory -Path $secretDir -Force | Out-Null
Set-CurrentUserOnlyAcl -Path $secretDir -Directory

$secure = Read-Host 'Runtime key (input is hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = $null
$temporaryPath = Join-Path $secretDir ('.control-plane-api-key.' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ([string]::IsNullOrWhiteSpace($plain) -or $plain -match '[\r\n]') {
        throw 'RUNTIME_SECRET_EMPTY: enter one non-empty runtime key without a newline.'
    }

    [IO.File]::WriteAllText($temporaryPath, $plain, [Text.UTF8Encoding]::new($false))
    Set-CurrentUserOnlyAcl -Path $temporaryPath
    [IO.File]::Move($temporaryPath, $secretPath, $true)
} finally {
    if ($ptr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
    $plain = $null
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

Write-Output 'RUNTIME_SECRET_INITIALIZED=YES'
Write-Output "SECRET_FILE=$secretPath"
Write-Output 'SECRET_CONTENT_PRINTED=NO'
Write-Output 'SECRET_NEWLINE=NONE'
Write-Output 'SECRET_ACL=CURRENT_USER_ONLY'
