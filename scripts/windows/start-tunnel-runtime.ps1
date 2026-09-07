#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateSet('bridge-local')]
    [string]$Alias = 'bridge-local',

    [ValidateSet('bridge-local')]
    [string]$Profile = 'bridge-local',

    [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:TunnelId = 'tunnel_6a9aefb73a748191ba6cc4dd9e2fae47'
$script:HealthPort = 8080
$script:CodexInstallRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
}

function Get-FullFilePath {
    param([AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or
        -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $null
    }

    return $item.FullName
}

function Test-PathUnderRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = ([IO.Path]::GetFullPath($Root)).TrimEnd('\') + '\'
    return $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)
}

function Get-CodexVersionInfo {
    param(
        [Parameter(Mandatory)][string]$Path,
        [AllowNull()][scriptblock]$VersionProbe
    )

    try {
        if ($null -ne $VersionProbe) {
            $output = & $VersionProbe $Path
            $exitCode = 0
        } else {
            $output = & $Path '--version' 2>$null
            $exitCode = $LASTEXITCODE
        }
    } catch {
        return $null
    }

    $text = (@($output) -join "`n").Trim()
    $match = [regex]::Match(
        $text,
        '(?im)^\s*codex-cli\s+(\d+\.\d+\.\d+)(?:\s|$)'
    )

    if ($exitCode -ne 0 -or -not $match.Success) {
        return $null
    }

    return [pscustomobject]@{
        Version = [version]$match.Groups[1].Value
        Text    = $text
    }
}

function Get-OfficialCodexCandidates {
    param([Parameter(Mandatory)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        return @()
    }

    $rootFull = (Get-Item -LiteralPath $Root -Force).FullName
    foreach ($item in Get-ChildItem -LiteralPath $rootFull -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            continue
        }

        $relative = [IO.Path]::GetRelativePath($rootFull, $item.FullName)
        $segments = $relative -split '[\\/]'
        $isRootPointer = $segments.Count -eq 1 -and $segments[0] -ieq 'codex.exe'
        $isVersionedInstall = $segments.Count -eq 2 -and $segments[1] -ieq 'codex.exe'

        if (-not ($isRootPointer -or $isVersionedInstall)) {
            continue
        }

        [pscustomobject]@{
            Path            = $item.FullName
            LastWriteTimeUtc = $item.LastWriteTimeUtc
            IsRootPointer   = $isRootPointer
        }
    }
}

function Resolve-CodexExecutable {
    param(
        [string]$CodexRoot = $script:CodexInstallRoot,
        [AllowNull()][string]$PathCommand,
        [AllowNull()][scriptblock]$VersionProbe
    )

    if ([string]::IsNullOrWhiteSpace($CodexRoot)) {
        throw 'LOCALAPPDATA is unavailable; cannot locate the official Codex installation root.'
    }

    if (-not (Test-Path -LiteralPath $CodexRoot -PathType Container)) {
        throw "Official Codex installation root does not exist: $CodexRoot"
    }

    $rootFull = (Get-Item -LiteralPath $CodexRoot -Force).FullName
    $pathCandidate = $PathCommand
    if ([string]::IsNullOrWhiteSpace($pathCandidate)) {
        $resolved = Get-Command 'codex.exe' -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $resolved) {
            $pathCandidate = $resolved.Source
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($pathCandidate)) {
        $pathFile = Get-FullFilePath -Path $pathCandidate
        if ($null -ne $pathFile -and (Test-PathUnderRoot -Path $pathFile -Root $rootFull)) {
            $version = Get-CodexVersionInfo -Path $pathFile -VersionProbe $VersionProbe
            if ($null -ne $version) {
                return [pscustomobject]@{
                    Path             = $pathFile
                    Bin              = Split-Path -Parent $pathFile
                    Version          = $version.Version
                    Resolution       = 'path'
                    CandidateCount   = 1
                }
            }
        }
    }

    $valid = @(
        foreach ($candidate in Get-OfficialCodexCandidates -Root $rootFull) {
            $version = Get-CodexVersionInfo -Path $candidate.Path -VersionProbe $VersionProbe
            if ($null -eq $version) {
                continue
            }

            [pscustomobject]@{
                Path             = $candidate.Path
                Bin              = Split-Path -Parent $candidate.Path
                Version          = $version.Version
                Resolution       = 'install-root'
                CandidateCount   = 0
                IsRootPointer    = $candidate.IsRootPointer
                LastWriteTimeUtc = $candidate.LastWriteTimeUtc
            }
        }
    )

    if ($valid.Count -eq 0) {
        throw "No valid official codex.exe was found under $rootFull. Expected codex-cli <version> from --version."
    }

    # Highest reported CLI version wins; the official root pointer wins ties,
    # then the newest file. Directory names are never used as a version signal.
    $selected = $valid |
        Sort-Object `
            @{ Expression = { $_.Version };          Descending = $true }, `
            @{ Expression = { $_.IsRootPointer };    Descending = $true }, `
            @{ Expression = { $_.LastWriteTimeUtc };  Descending = $true }, `
            @{ Expression = { $_.Path };              Descending = $false } |
        Select-Object -First 1

    $selected.CandidateCount = $valid.Count
    return $selected
}

function Add-CodexToProcessPath {
    param([Parameter(Mandatory)][string]$CodexBin)

    $bin = (Get-Item -LiteralPath $CodexBin -Force).FullName
    $separator = [IO.Path]::PathSeparator
    $entries = @()
    if (-not [string]::IsNullOrWhiteSpace($env:Path)) {
        $entries = @($env:Path -split [regex]::Escape($separator))
    }

    if (-not ($entries | Where-Object { $_ -ieq $bin })) {
        $env:Path = if ([string]::IsNullOrWhiteSpace($env:Path)) {
            $bin
        } else {
            "$bin$separator$($env:Path)"
        }
    }

    return $env:Path
}

function Assert-RuntimeKey {
    param([AllowEmptyString()][AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw 'CONTROL_PLANE_API_KEY is missing. Set it in this PowerShell session; the launcher never accepts a literal key.'
    }
}

function Assert-BridgePreflight {
    param([Parameter(Mandatory)][string]$Root)

    $mcpEntry = Join-Path $Root 'dist\src\mcp-stdio.js'
    $workspaceConfig = Join-Path $Root 'var\workspaces.windows.local.json'
    if (-not (Test-Path -LiteralPath $mcpEntry -PathType Leaf)) {
        throw "Bridge build output is missing: $mcpEntry. Run npm run build manually first."
    }
    if (-not (Test-Path -LiteralPath $workspaceConfig -PathType Leaf)) {
        throw "Bridge workspace config is missing: $workspaceConfig"
    }

    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $nodePath = if ($null -ne $node) { Get-FullFilePath -Path $node.Source }
    if ($null -eq $nodePath) {
        throw 'node.exe is not available as a regular executable on PATH.'
    }

    return [pscustomobject]@{
        NodePath        = $nodePath
        McpEntry        = (Get-Item -LiteralPath $mcpEntry -Force).FullName
        WorkspaceConfig = (Get-Item -LiteralPath $workspaceConfig -Force).FullName
    }
}

function New-TunnelMcpCommand {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$McpEntry,
        [Parameter(Mandatory)][string]$WorkspaceConfig
    )

    # tunnel-client receives one command string; forward slashes prevent its
    # Windows command tokenizer from treating backslashes as escapes.
    $paths = @($NodePath, $McpEntry, $WorkspaceConfig) | ForEach-Object {
        ([IO.Path]::GetFullPath($_)) -replace '\\', '/'
    }
    return ('"{0}" "{1}" "{2}"' -f $paths[0], $paths[1], $paths[2])
}

function Get-ExistingTunnelProfileDir {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw 'APPDATA is unavailable; cannot locate the existing Tunnel profile.'
    }

    $profileDir = Join-Path $env:APPDATA 'tunnel-client'
    $profilePath = Join-Path $profileDir ($Profile + '.yaml')
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
        throw "Existing Tunnel profile is missing: $profilePath"
    }
    return $profileDir
}

function Get-ManagedRuntimeFailureReason {
    param(
        [Parameter(Mandatory)]$Status
    )

    foreach ($propertyName in @('error', 'remote_error')) {
        $property = $Status.PSObject.Properties[$propertyName]
        if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
            return [string]$property.Value
        }
    }

    $issues = $Status.PSObject.Properties['local']
    if ($null -ne $issues -and $null -ne $issues.Value.issues) {
        $text = @($issues.Value.issues) -join '; '
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            return $text
        }
    }

    return 'inspect tunnel-client runtimes status for details'
}

function Resolve-TunnelClient {
    $pathCommand = Get-Command 'tunnel-client.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $pathCandidate = if ($null -ne $pathCommand) { Get-FullFilePath -Path $pathCommand.Source }
    if ($null -ne $pathCandidate) {
        return $pathCandidate
    }

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is unavailable; cannot locate tunnel-client.'
    }

    $root = Join-Path $env:LOCALAPPDATA 'OpenAI\tunnel-client'
    $valid = @(
        foreach ($candidate in Get-ChildItem -LiteralPath $root -Filter 'tunnel-client.exe' -File -Recurse -ErrorAction SilentlyContinue) {
            if (($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                continue
            }
            $version = (& $candidate.FullName '--version' 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($version)) {
                [pscustomobject]@{
                    Path             = $candidate.FullName
                    LastWriteTimeUtc = $candidate.LastWriteTimeUtc
                }
            }
        }
    )

    if ($valid.Count -eq 0) {
        throw "No usable tunnel-client.exe was found under $root."
    }

    return ($valid | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).Path
}

function Invoke-TunnelJson {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $raw = & $Executable @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    $text = (@($raw) -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }

    try {
        return ($text | ConvertFrom-Json -Depth 20)
    } catch {
        return $null
    }
}

function Get-RequiredBoolean {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return [bool]$property.Value
}

function Wait-ManagedRuntimeReady {
    param(
        [Parameter(Mandatory)][string]$TunnelClient,
        [Parameter(Mandatory)][string]$Alias,
        [int]$Attempts = 30
    )

    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $status = Invoke-TunnelJson -Executable $TunnelClient -Arguments @('runtimes', 'status', $Alias, '--json')
        if ($null -ne $status) {
            $processRunning = Get-RequiredBoolean -Object $status -Name 'process_running'
            $healthy = Get-RequiredBoolean -Object $status -Name 'healthy'
            $ready = Get-RequiredBoolean -Object $status -Name 'ready'
            if ($processRunning -eq $true -and $healthy -eq $true -and $ready -eq $true) {
                return $status
            }
        }
        Start-Sleep -Seconds 1
    }

    throw "Managed runtime '$Alias' did not reach process_running=true, healthy=true, ready=true."
}

function Invoke-Launcher {
    $userPathBefore = [Environment]::GetEnvironmentVariable('Path', 'User')
    $machinePathBefore = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $preflight = Assert-BridgePreflight -Root $script:ProjectRoot
    $codex = Resolve-CodexExecutable

    Add-CodexToProcessPath -CodexBin $codex.Bin | Out-Null
    $resolved = Get-Command 'codex.exe' -CommandType Application -ErrorAction Stop
    $resolvedPath = (Get-FullFilePath -Path $resolved.Source)
    if ($resolvedPath -ne $codex.Path) {
        throw "Process-local Codex resolution did not select the validated executable: $resolvedPath"
    }

    $sessionVersion = Get-CodexVersionInfo -Path $codex.Path
    if ($null -eq $sessionVersion) {
        throw 'codex --version did not return the expected codex-cli <version> output.'
    }

    $null = & $codex.Path 'login' 'status' 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'codex login status failed; authenticate Codex before starting the Tunnel.'
    }

    Assert-RuntimeKey -Value $env:CONTROL_PLANE_API_KEY
    $tunnelClient = Resolve-TunnelClient
    $profileDir = Get-ExistingTunnelProfileDir
    $mcpCommand = New-TunnelMcpCommand `
        -NodePath $preflight.NodePath `
        -McpEntry $preflight.McpEntry `
        -WorkspaceConfig $preflight.WorkspaceConfig

    $connectArgs = @(
        'runtimes', 'connect',
        '--alias', $Alias,
        '--profile-dir', $profileDir,
        '--profile', $Profile,
        '--tunnel-id', $script:TunnelId,
        '--runtime-api-key', 'env:CONTROL_PLANE_API_KEY',
        '--mcp-command', $mcpCommand,
        '--json'
    )
    $null = & $tunnelClient @connectArgs 2>$null
    $connectExitCode = $LASTEXITCODE
    if ($connectExitCode -ne 0) {
        $status = Invoke-TunnelJson -Executable $tunnelClient -Arguments @(
            'runtimes', 'status', $Alias, '--json'
        )
        $reason = if ($null -ne $status) {
            Get-ManagedRuntimeFailureReason -Status $status
        } else {
            'inspect tunnel-client runtimes status for details'
        }
        throw "tunnel-client runtimes connect failed for alias '$Alias': $reason"
    }

    $null = Wait-ManagedRuntimeReady -TunnelClient $tunnelClient -Alias $Alias
    $null = & $tunnelClient 'health' '--port' $script:HealthPort '--require-control-plane-poll' '--json' 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'Managed runtime health/ready/control-plane poll verification failed.'
    }

    $userPathAfter = [Environment]::GetEnvironmentVariable('Path', 'User')
    $machinePathAfter = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if ($userPathBefore -ne $userPathAfter -or $machinePathBefore -ne $machinePathAfter) {
        throw 'Permanent User or Machine PATH changed unexpectedly.'
    }

    Write-Output 'TUNNEL_LAUNCHER_STATUS=PASS'
    Write-Output "CODEX_DYNAMIC_RESOLUTION=PASS ($($codex.Resolution))"
    Write-Output 'CODEX_HASH_HARDCODED=NO'
    Write-Output 'CODEX_PATH_PROCESS_LOCAL=YES'
    Write-Output 'PERMANENT_PATH_MODIFIED=NO'
    Write-Output "CODEX_EXE=$($codex.Path)"
    Write-Output "CODEX_VERSION=$($sessionVersion.Text)"
    Write-Output "MANAGED_RUNTIME_ALIAS=$Alias"
    Write-Output 'MANAGED_RUNTIME_USED=YES'
    Write-Output 'TUNNEL_REUSED=YES'
    Write-Output 'TUNNEL_HEALTH=PASS'
    Write-Output 'TUNNEL_READY=PASS'
    Write-Output 'CONTROL_PLANE=PASS'
    Write-Output 'STOPWATCH_LIST_SMOKE=RUN_SEPARATELY'
}

if (-not $LibraryOnly) {
    try {
        Invoke-Launcher
    } catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
