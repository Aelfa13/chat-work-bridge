#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'start-tunnel-runtime.ps1'
. $launcher -LibraryOnly

$script:Passed = 0

function Assert-Test {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )

    if (-not $Condition) {
        throw "FAIL: $Message"
    }
    $script:Passed++
}

function Assert-Throws {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$Message
    )

    $thrown = $false
    try {
        & $Action
    } catch {
        $thrown = $true
    }
    Assert-Test -Condition $thrown -Message $Message
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('chat-work-bridge-launcher-' + [guid]::NewGuid().ToString('N'))
$oldPath = $env:Path
$userPathBefore = [Environment]::GetEnvironmentVariable('Path', 'User')
$machinePathBefore = [Environment]::GetEnvironmentVariable('Path', 'Machine')

try {
    $oldDir = Join-Path $fixture 'old-hash'
    $newDir = Join-Path $fixture 'new-hash'
    $freshDir = Join-Path $fixture 'fresh-hash'
    New-Item -ItemType Directory -Path $oldDir, $newDir, $freshDir -Force | Out-Null
    New-Item -ItemType File -Path (Join-Path $oldDir 'codex.exe'), (Join-Path $newDir 'codex.exe') -Force | Out-Null

    $probe = {
        param($path)
        if ($path -like '*old-hash*') { return 'codex-cli 0.152.0' }
        if ($path -like '*new-hash*') { return 'codex-cli 0.153.4' }
        if ($path -like '*fresh-hash*') { return 'codex-cli 0.154.0' }
        return 'not-codex'
    }

    $resolved = Resolve-CodexExecutable -CodexRoot $fixture -PathCommand $null -VersionProbe $probe
    Assert-Test ($resolved.Path -like '*new-hash*\codex.exe') 'highest valid Codex version is selected when PATH cannot resolve codex.exe'
    Assert-Test ($resolved.Version -eq [version]'0.153.4') 'selected Codex version is validated'

    Remove-Item -LiteralPath (Join-Path $oldDir 'codex.exe')
    New-Item -ItemType File -Path (Join-Path $freshDir 'codex.exe') -Force | Out-Null
    $updated = Resolve-CodexExecutable -CodexRoot $fixture -PathCommand $null -VersionProbe $probe
    Assert-Test ($updated.Path -like '*fresh-hash*\codex.exe') 'new installation candidate is selected after the old candidate disappears'
    Assert-Test ($updated.Version -eq [version]'0.154.0') 'updated candidate version is validated'

    $outside = Join-Path $fixture 'outside-codex.exe'
    New-Item -ItemType File -Path $outside -Force | Out-Null
    $fromRoot = Resolve-CodexExecutable -CodexRoot $fixture -PathCommand $outside -VersionProbe $probe
    Assert-Test ($fromRoot.Path -like '*fresh-hash*\codex.exe') 'third-party/outside PATH candidate is rejected'

    $emptyRoot = Join-Path $fixture 'empty'
    New-Item -ItemType Directory -Path $emptyRoot -Force | Out-Null
    Assert-Throws {
        Resolve-CodexExecutable -CodexRoot $emptyRoot -PathCommand $null -VersionProbe $probe | Out-Null
    } 'missing Codex fails closed'

    $invalidRoot = Join-Path $fixture 'invalid'
    New-Item -ItemType Directory -Path (Join-Path $invalidRoot 'candidate') -Force | Out-Null
    New-Item -ItemType File -Path (Join-Path $invalidRoot 'candidate\codex.exe') -Force | Out-Null
    Assert-Throws {
        Resolve-CodexExecutable -CodexRoot $invalidRoot -PathCommand $null -VersionProbe $probe | Out-Null
    } 'invalid Codex version output fails closed'

    Assert-Throws { Assert-RuntimeKey -Value '' } 'missing runtime key fails closed'

    $missingDistRoot = Join-Path $fixture 'missing-dist'
    New-Item -ItemType Directory -Path (Join-Path $missingDistRoot 'var') -Force | Out-Null
    New-Item -ItemType File -Path (Join-Path $missingDistRoot 'var\workspaces.windows.local.json') -Force | Out-Null
    Assert-Throws {
        Assert-BridgePreflight -Root $missingDistRoot | Out-Null
    } 'missing dist entrypoint fails closed'

    $mcpCommand = New-TunnelMcpCommand `
        -NodePath 'C:\Program Files\nodejs\node.exe' `
        -McpEntry 'D:\HuaweiMoveData\Users\aelfa\Documents\codex project\chat-work-bridge\dist\src\mcp-stdio.js' `
        -WorkspaceConfig 'D:\HuaweiMoveData\Users\aelfa\Documents\codex project\chat-work-bridge\var\workspaces.windows.local.json'
    Assert-Test ($mcpCommand -like '"C:/Program Files/nodejs/node.exe" *') 'MCP command uses a quoted absolute Node path with parser-safe separators'
    Assert-Test ($mcpCommand -like '*"D:/HuaweiMoveData/Users/aelfa/Documents/codex project/chat-work-bridge/dist/src/mcp-stdio.js"*') 'MCP command preserves the Bridge entrypoint and spaces'

    Add-CodexToProcessPath -CodexBin $freshDir | Out-Null
    $firstPathEntry = ($env:Path -split [regex]::Escape([IO.Path]::PathSeparator))[0]
    Assert-Test ($firstPathEntry -ieq (Get-Item -LiteralPath $freshDir).FullName) 'Codex directory is prepended to process-local PATH'
    Assert-Test ([Environment]::GetEnvironmentVariable('Path', 'User') -eq $userPathBefore) 'User PATH is unchanged'
    Assert-Test ([Environment]::GetEnvironmentVariable('Path', 'Machine') -eq $machinePathBefore) 'Machine PATH is unchanged'

    Write-Output "TARGETED_TESTS=PASS ($script:Passed assertions)"
} finally {
    $env:Path = $oldPath
    if (Test-Path -LiteralPath $fixture) {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
