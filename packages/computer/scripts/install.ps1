<#
.SYNOPSIS
  Install the self-contained Raft Computer executable on Windows.

.EXAMPLE
  irm https://cdn.raft.build/computer/install.ps1 | iex

.EXAMPLE
  irm https://cdn.raft.build/computer/install.ps1 -OutFile install.ps1
  .\install.ps1 -Channel alpha

.EXAMPLE
  .\install.ps1 -Version 1.0.19

.NOTES
  PowerShell 5.1 or newer is supported. Optional environment variables:
    RAFT_COMPUTER_VERSION          Pin a version instead of resolving the
                                   channel's active release through Hands.
    RAFT_COMPUTER_INSTALL_DIR      Install directory (default: ~/.local/bin).
    RAFT_COMPUTER_RELEASE_BASE     CDN base holding per-version subdirs
                                   (default: public production CDN).
    RAFT_COMPUTER_HANDS_ORIGIN     Hands release authority origin for version
                                   selection (default: https://hands.build).
                                   For channel and pinned versions this authority is
                                   load-bearing: unreachable means refuse, not
                                   CDN-pointer fallback.
    RAFT_COMPUTER_HANDS_APP        Hands app slug (default: raft-computer-cli).
    RAFT_COMPUTER_INSTALL_CHANNEL  Persist latest, alpha, or pinned:<semver>.
    RAFT_COMPUTER_FORCE            Set to 1 to reinstall or allow downgrade.
    RAFT_COMPUTER_NO_MODIFY_PATH   Set to 1 to leave the user PATH unchanged.
    RAFT_COMPUTER_REQUIRE_GIT_BASH Set to 1 to require Git Bash for an
                                   upstream Bash-only runtime such as Pi CLI.
    RAFT_COMPUTER_GIT_BASH_PATH    Optional absolute path to bash.exe.
#>

[CmdletBinding()]
param(
  [ValidateSet('main', 'alpha')]
  [string]$Channel,

  [string]$Version
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 can otherwise negotiate TLS 1.0 on older hosts.
[Net.ServicePointManager]::SecurityProtocol =
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$BinaryName = 'raft-computer.exe'
$CommandName = 'raft-computer'
$PhotonWasmName = 'photon_rs_bg.wasm'
$DefaultInstallDir = Join-Path $env:USERPROFILE '.local\bin'
$InstallDir = if ($env:RAFT_COMPUTER_INSTALL_DIR) {
  [System.IO.Path]::GetFullPath($env:RAFT_COMPUTER_INSTALL_DIR)
} else {
  [System.IO.Path]::GetFullPath($DefaultInstallDir)
}
$ReleaseBase = if ($env:RAFT_COMPUTER_RELEASE_BASE) {
  $env:RAFT_COMPUTER_RELEASE_BASE.TrimEnd('/')
} else {
  'https://cdn.raft.build/computer'
}
$HandsOrigin = if ($env:RAFT_COMPUTER_HANDS_ORIGIN) {
  $env:RAFT_COMPUTER_HANDS_ORIGIN.TrimEnd('/')
} else {
  'https://hands.build'
}
$HandsApp = if ($env:RAFT_COMPUTER_HANDS_APP) { $env:RAFT_COMPUTER_HANDS_APP } else { 'raft-computer-cli' }
$VersionArgumentProvided = $PSBoundParameters.ContainsKey('Version')
if (-not $VersionArgumentProvided) {
  $Version = $env:RAFT_COMPUTER_VERSION
}
$InstallChannelDefault = ''
$InstallChannel = if ($PSBoundParameters.ContainsKey('Channel')) {
  if ($Channel -eq 'main') { 'latest' } else { $Channel }
} elseif ($env:RAFT_COMPUTER_INSTALL_CHANNEL) {
  $env:RAFT_COMPUTER_INSTALL_CHANNEL
} else {
  $InstallChannelDefault
}
$Force = $env:RAFT_COMPUTER_FORCE -eq '1'
$NoModifyPath = $env:RAFT_COMPUTER_NO_MODIFY_PATH -eq '1'
$RequireGitBash = $env:RAFT_COMPUTER_REQUIRE_GIT_BASH -eq '1'
$StateHome = if ($env:SLOCK_HOME) {
  [System.IO.Path]::GetFullPath($env:SLOCK_HOME)
} elseif ($env:RAFT_HOME) {
  [System.IO.Path]::GetFullPath($env:RAFT_HOME)
} else {
  Join-Path $env:USERPROFILE '.slock'
}
$KStateDir = Join-Path (Join-Path $StateHome 'computer') 'k'
$script:KEffectiveTarget = $null

function Write-Step([string]$Message) {
  Write-Host "[install] $Message" -ForegroundColor Cyan
}

function Retire-LegacySupervisor([string]$Destination) {
  & $Destination __supervisor retire-legacy | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail "the installed Computer could not complete its detached lifecycle. Run '$Destination status' and '$Destination start', then re-run this installer."
  }
}

function Test-LegacyComputerState([string]$Destination) {
  if (Test-Path -LiteralPath $Destination) { return $true }
  $stateHome = if ($env:SLOCK_HOME) {
    $env:SLOCK_HOME
  } elseif ($env:RAFT_HOME) {
    $env:RAFT_HOME
  } else {
    Join-Path $env:USERPROFILE '.slock'
  }
  return Test-Path -LiteralPath (Join-Path $stateHome 'computer')
}

function Fail([string]$Message) {
  if ($script:KEffectiveTarget) {
    throw "[install] error: effective K stable is v$($script:KEffectiveTarget); PATH dispatcher remains stale: $Message Re-run this installer to publish the verified dispatcher."
  }
  throw "[install] error: $Message"
}

function Invoke-Download([string]$Uri, [string]$OutFile) {
  Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
}

function Read-Json([string]$Uri) {
  $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing
  $content = $response.Content
  if ($content -is [byte[]]) {
    $content = [System.Text.Encoding]::UTF8.GetString($content)
  }
  return $content | ConvertFrom-Json
}

function Get-Target {
  $rawArch = try {
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    if ($env:PROCESSOR_ARCHITEW6432) {
      $env:PROCESSOR_ARCHITEW6432
    } else {
      $env:PROCESSOR_ARCHITECTURE
    }
  }

  $arch = switch ($rawArch.ToUpperInvariant()) {
    'AMD64' { 'x64' }
    'X64' { 'x64' }
    'ARM64' { 'arm64' }
    default { Fail "unsupported Windows architecture: $rawArch" }
  }
  return "win32-$arch"
}

function Find-GitBash {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:RAFT_COMPUTER_GIT_BASH_PATH) {
    $candidates.Add($env:RAFT_COMPUTER_GIT_BASH_PATH)
  }
  foreach ($entry in @($env:Path -split ';' | Where-Object { $_ })) {
    if (-not [System.IO.Path]::IsPathRooted($entry)) { continue }
    $candidates.Add((Join-Path $entry 'bash.exe'))
  }
  $candidates.Add('C:\Program Files\Git\bin\bash.exe')
  $candidates.Add('C:\Program Files\Git\usr\bin\bash.exe')
  $candidates.Add('C:\Program Files (x86)\Git\bin\bash.exe')
  $candidates.Add('C:\Program Files (x86)\Git\usr\bin\bash.exe')
  if ($env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe'))
    $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git\usr\bin\bash.exe'))
  }

  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    try {
      $absolute = [System.IO.Path]::GetFullPath($candidate)
      if (Test-Path -LiteralPath $absolute -PathType Leaf) { return $absolute }
    } catch {}
  }
  return $null
}

function Assert-GitBashRequirement {
  if (-not $RequireGitBash) { return }
  $gitBash = Find-GitBash
  if (-not $gitBash) {
    Fail ('Git Bash is required by RAFT_COMPUTER_REQUIRE_GIT_BASH=1 but was not found. ' +
      'Install Git for Windows from https://gitforwindows.org/, or set ' +
      'RAFT_COMPUTER_GIT_BASH_PATH to an app-local PortableGit bash.exe. ' +
      'Raft managed Pi uses native PowerShell and does not require Git Bash; ' +
      'the upstream standalone Pi CLI does, and its settings.json shellPath must point to bash.exe.')
  }
  Write-Step "Git Bash requirement satisfied ($gitBash)"
}

function Test-Sha256([string]$Path, [string]$Expected) {
  if ($Expected -notmatch '^[a-fA-F0-9]{64}$') {
    Fail "invalid sha256 in manifest: $Expected"
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    Fail "sha256 mismatch for $([System.IO.Path]::GetFileName($Path)) (got $actual, want $Expected)"
  }
}

function Expand-Gzip([string]$Source, [string]$Destination) {
  $input = [System.IO.File]::OpenRead($Source)
  try {
    $gzip = New-Object System.IO.Compression.GzipStream(
      $input,
      [System.IO.Compression.CompressionMode]::Decompress
    )
    try {
      $output = [System.IO.File]::Create($Destination)
      try { $gzip.CopyTo($output) } finally { $output.Dispose() }
    } finally { $gzip.Dispose() }
  } finally { $input.Dispose() }
}

function Assert-PeTarget([string]$Path, [string]$Target) {
  $expectedMachine = switch ($Target) {
    'win32-x64' { 0x8664 }
    'win32-arm64' { 0xAA64 }
    default { Fail "unsupported Windows target: $Target" }
  }

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = New-Object System.IO.BinaryReader($stream)
    try {
      if ($reader.ReadUInt16() -ne 0x5A4D) { Fail 'downloaded binary is not a PE executable (missing MZ header)' }
      $stream.Seek(0x3C, [System.IO.SeekOrigin]::Begin) | Out-Null
      $peOffset = $reader.ReadInt32()
      if ($peOffset -lt 0 -or $peOffset -gt ($stream.Length - 6)) { Fail 'downloaded binary has an invalid PE header offset' }
      $stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
      if ($reader.ReadUInt32() -ne 0x00004550) { Fail 'downloaded binary is not a PE executable (missing PE header)' }
      $actualMachine = $reader.ReadUInt16()
      if ($actualMachine -ne $expectedMachine) {
        Fail ('downloaded binary architecture mismatch (target={0}, PE machine=0x{1:X4})' -f $Target, $actualMachine)
      }
    } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}

function Get-BinaryResidentVersion([string]$Path) {
  try {
    $line = (& $Path --version 2>$null | Select-Object -First 1)
    if (-not $line) { return $null }
    $token = (($line.ToString().Trim() -split '\s+')[0]).TrimStart('v')
    if ($token) { return $token }
  } catch {}
  return $null
}

# Probe one exact file without allowing an installed dispatcher to hand
# `--version` to the real K stable slot.
function Get-BinarySelfVersion([string]$Path) {
  $probeHome = Join-Path $env:TEMP ("raft-computer-version-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $probeHome | Out-Null
  $oldSlockHome = $env:SLOCK_HOME
  $oldRaftHome = $env:RAFT_HOME
  try {
    $env:SLOCK_HOME = $probeHome
    $env:RAFT_HOME = $probeHome
    return Get-BinaryResidentVersion $Path
  } finally {
    $env:SLOCK_HOME = $oldSlockHome
    $env:RAFT_HOME = $oldRaftHome
    Remove-Item -LiteralPath $probeHome -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function ConvertTo-SemVer([string]$Value, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    Fail "could not determine $Label version; refusing to continue"
  }
  if ($Value -match '\s') {
    Fail "$Label reported invalid SemVer '$Value'; refusing to continue"
  }

  $main = $Value
  $plus = $Value.IndexOf('+')
  if ($plus -ge 0) {
    if ($Value.IndexOf('+', $plus + 1) -ge 0) {
      Fail "$Label reported invalid SemVer '$Value'; refusing to continue"
    }
    $build = $Value.Substring($plus + 1)
    $main = $Value.Substring(0, $plus)
    if (-not $build) {
      Fail "$Label reported invalid SemVer '$Value'; refusing to continue"
    }
    foreach ($identifier in @($build.Split('.'))) {
      if (-not $identifier -or $identifier -notmatch '^[0-9A-Za-z-]+$') {
        Fail "$Label reported invalid SemVer '$Value'; refusing to continue"
      }
    }
  }

  $core = $main
  $prerelease = $null
  $dash = $main.IndexOf('-')
  if ($dash -ge 0) {
    $core = $main.Substring(0, $dash)
    $prerelease = $main.Substring($dash + 1)
    if (-not $prerelease) {
      Fail "$Label reported invalid SemVer '$Value'; refusing to continue"
    }
  }

  $coreParts = @($core.Split('.'))
  if ($coreParts.Count -ne 3) {
    Fail "$Label reported invalid SemVer '$Value'; refusing to continue"
  }
  foreach ($identifier in $coreParts) {
    if ($identifier -notmatch '^(0|[1-9][0-9]*)$') {
      Fail "$Label reported invalid SemVer '$Value'; refusing to continue"
    }
  }

  $prereleaseParts = @()
  if ($null -ne $prerelease) {
    $prereleaseParts = @($prerelease.Split('.'))
    foreach ($identifier in $prereleaseParts) {
      if (
        -not $identifier -or
        $identifier -notmatch '^[0-9A-Za-z-]+$' -or
        ($identifier -match '^[0-9]+$' -and $identifier.Length -gt 1 -and $identifier.StartsWith('0'))
      ) {
        Fail "$Label reported invalid SemVer '$Value'; refusing to continue"
      }
    }
  }

  return [pscustomobject]@{
    Core = $coreParts
    Prerelease = $prereleaseParts
  }
}

function Compare-NumericIdentifier([string]$Left, [string]$Right) {
  if ($Left.Length -gt $Right.Length) { return 1 }
  if ($Left.Length -lt $Right.Length) { return -1 }
  return [Math]::Sign([string]::CompareOrdinal($Left, $Right))
}

function Compare-SemVer([string]$Left, [string]$Right, [string]$LeftLabel) {
  $leftVersion = ConvertTo-SemVer $Left $LeftLabel
  $rightVersion = ConvertTo-SemVer $Right 'target release'

  for ($index = 0; $index -lt 3; $index++) {
    $comparison = Compare-NumericIdentifier $leftVersion.Core[$index] $rightVersion.Core[$index]
    if ($comparison -ne 0) { return $comparison }
  }

  $leftPre = @($leftVersion.Prerelease)
  $rightPre = @($rightVersion.Prerelease)
  if ($leftPre.Count -eq 0 -and $rightPre.Count -eq 0) { return 0 }
  if ($leftPre.Count -eq 0) { return 1 }
  if ($rightPre.Count -eq 0) { return -1 }

  $limit = [Math]::Min($leftPre.Count, $rightPre.Count)
  for ($index = 0; $index -lt $limit; $index++) {
    $leftNumeric = $leftPre[$index] -match '^[0-9]+$'
    $rightNumeric = $rightPre[$index] -match '^[0-9]+$'
    if ($leftNumeric -and $rightNumeric) {
      $comparison = Compare-NumericIdentifier $leftPre[$index] $rightPre[$index]
    } elseif ($leftNumeric) {
      $comparison = -1
    } elseif ($rightNumeric) {
      $comparison = 1
    } else {
      $comparison = [Math]::Sign([string]::CompareOrdinal($leftPre[$index], $rightPre[$index]))
    }
    if ($comparison -ne 0) { return $comparison }
  }
  return [Math]::Sign($leftPre.Count - $rightPre.Count)
}

function Refuse-NewerVersion([string]$Label, [string]$ObservedVersion, [string]$TargetVersion) {
  if ((Compare-SemVer $ObservedVersion $TargetVersion $Label) -gt 0) {
    Add-ToUserPath $InstallDir
    Write-Step "$Label v$ObservedVersion is newer than target v$TargetVersion; refusing to downgrade"
    Write-Step 'set RAFT_COMPUTER_FORCE=1 to install the older version anyway'
    return $true
  }
  return $false
}

function Persist-InstallChannel {
  if (-not $InstallChannel) { return }
  if ($InstallChannel -notmatch '^(latest|alpha|pinned:\d+\.\d+\.\d+(?:-[A-Za-z0-9_.-]+)?)$') {
    Fail "invalid RAFT_COMPUTER_INSTALL_CHANNEL: $InstallChannel"
  }

  $stateHome = if ($env:SLOCK_HOME) {
    $env:SLOCK_HOME
  } elseif ($env:RAFT_HOME) {
    $env:RAFT_HOME
  } else {
    Join-Path $env:USERPROFILE '.slock'
  }
  $channelDir = Join-Path $stateHome 'computer'
  $channelFile = Join-Path $channelDir 'channel'
  if (Test-Path -LiteralPath $channelFile) {
    $existing = (Get-Content -LiteralPath $channelFile -Raw).Trim()
    if ($existing.StartsWith('pinned:') -and $existing -ne $InstallChannel) {
      Write-Step "preserving existing pinned release channel ($existing); installer channel $InstallChannel not written"
      return
    }
  }

  New-Item -ItemType Directory -Path $channelDir -Force | Out-Null
  $tempChannel = "$channelFile.$([guid]::NewGuid().ToString('N')).tmp"
  [System.IO.File]::WriteAllText($tempChannel, "$InstallChannel`n", (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tempChannel -Destination $channelFile -Force
  Write-Step "release channel set to $InstallChannel ($channelFile)"
}

function Add-ToUserPath([string]$Directory) {
  $currentEntries = @($env:Path -split ';' | Where-Object { $_ })
  $inCurrentProcess = $currentEntries | Where-Object {
    $_.TrimEnd('\').Equals($Directory.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
  }
  if (-not $inCurrentProcess) { $env:Path = "$Directory;$env:Path" }

  if ($NoModifyPath) {
    Write-Step 'user PATH update disabled by RAFT_COMPUTER_NO_MODIFY_PATH=1'
    return
  }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $userEntries = @($userPath -split ';' | Where-Object { $_ })
  $alreadyPresent = $userEntries | Where-Object {
    $_.TrimEnd('\').Equals($Directory.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
  }
  if ($alreadyPresent) {
    Write-Step "$Directory is already in the user PATH"
    return
  }
  $newPath = if ($userPath) { "$Directory;$userPath" } else { $Directory }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Step "added $Directory to the user PATH (new terminals will pick it up)"
}

function Install-Binary(
  [string]$Source,
  [string]$Destination,
  [string]$ExpectedVersion,
  [string]$ExpectedSha256
) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  $destinationFile = [System.IO.Path]::GetFileName($Destination)
  $destinationStem = [System.IO.Path]::GetFileNameWithoutExtension($destinationFile)
  $destinationExtension = [System.IO.Path]::GetExtension($destinationFile)
  if ($destinationExtension -ne '.exe') {
    Fail "Windows install destination must end in .exe: $destinationFile"
  }
  $stagedName = ".$destinationStem.install.$([guid]::NewGuid().ToString('N'))$destinationExtension"
  $staged = Join-Path (Split-Path -Parent $Destination) $stagedName
  Copy-Item -LiteralPath $Source -Destination $staged -Force
  Test-Sha256 $staged $ExpectedSha256
  $stagedVersion = Get-BinarySelfVersion $staged
  if ($stagedVersion -ne $ExpectedVersion) {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    Fail "staged binary reported version '$stagedVersion', expected '$ExpectedVersion'"
  }
  $backup = $null
  if (Test-Path -LiteralPath $Destination) {
    $backup = "$Destination.bak"
    if (Test-Path -LiteralPath $backup) {
      try {
        Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
      } catch {
        $backup = "$Destination.$([guid]::NewGuid().ToString('N').Substring(0, 8)).bak"
      }
    }
    # Windows permits renaming a running executable, but not overwriting it.
    Move-Item -LiteralPath $Destination -Destination $backup -Force
    Write-Step "backed up the existing executable to $([System.IO.Path]::GetFileName($backup))"
  }

  try {
    Move-Item -LiteralPath $staged -Destination $Destination -Force
    Test-Sha256 $Destination $ExpectedSha256
    $installedVersion = Get-BinarySelfVersion $Destination
    if ($installedVersion -ne $ExpectedVersion) {
      Fail "installed binary reported version '$installedVersion', expected '$ExpectedVersion'"
    }
  } catch {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    if ($backup -and (Test-Path -LiteralPath $backup)) {
      Move-Item -LiteralPath $backup -Destination $Destination -Force
    }
    throw
  }

  if ($backup) {
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $backup) {
      Write-Step "previous executable remains at $backup until its running process exits"
    }
  }
}

function Install-PhotonWasm(
  [string]$Source,
  [string]$Destination,
  [string]$ExpectedSha256
) {
  if ([System.IO.Path]::GetFileName($Destination) -ne $PhotonWasmName) {
    Fail "image processing resource destination must be $PhotonWasmName"
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  $staged = Join-Path (Split-Path -Parent $Destination) ".$PhotonWasmName.install.$([guid]::NewGuid().ToString('N'))"
  Copy-Item -LiteralPath $Source -Destination $staged -Force
  Test-Sha256 $staged $ExpectedSha256
  Move-Item -LiteralPath $staged -Destination $Destination -Force
  Test-Sha256 $Destination $ExpectedSha256
}

function Assert-HandsManifestTargetIdentity(
  [object]$HandsLatest,
  [string]$Target,
  [object]$ManifestEntry,
  [string]$Version,
  [string]$HandsChannel,
  [string]$HandsApp
) {
  if (-not $HandsLatest) { return }

  $targetParts = @($Target -split '-', 2)
  if ($targetParts.Count -ne 2) { Fail "invalid target for Hands/CDN identity reconciliation: $Target" }
  $assets = @($HandsLatest.assets | Where-Object {
    $_.platform -eq $targetParts[0] -and
    $_.arch -eq $targetParts[1] -and
    $_.filetype -eq 'binary' -and
    $null -eq $_.variant
  })
  if ($assets.Count -ne 1) {
    Fail "Hands $HandsChannel response for $HandsApp must carry exactly one raw asset for $Target; got $($assets.Count). Refusing before download because Hands/CDN identity cannot be reconciled"
  }

  $asset = $assets[0]
  $handsSha = if ($asset.sha256) { $asset.sha256.ToString().ToLowerInvariant() } else { '' }
  $handsSize = $asset.size_bytes
  $manifestSha = if ($ManifestEntry.sha256) { $ManifestEntry.sha256.ToString().ToLowerInvariant() } else { '' }
  $manifestSize = $ManifestEntry.size
  if (-not $handsSha -or -not $handsSize -or -not $manifestSha -or -not $manifestSize) {
    Fail "Hands $HandsChannel raw asset for $Target and CDN manifest target must both carry sha256/size_bytes; refusing before download because identity cannot be reconciled"
  }
  if ($handsSha -ne $manifestSha -or [int64]$handsSize -ne [int64]$manifestSize) {
    Fail "Hands/CDN identity mismatch for $Target v$($Version): Hands sha256=$handsSha size_bytes=$handsSize; manifest sha256=$manifestSha size=$manifestSize. Refusing before download"
  }
}

try {
  if ($VersionArgumentProvided -and [string]::IsNullOrWhiteSpace($Version)) {
    Fail "invalid -Version: expected a SemVer value"
  }
  $target = Get-Target
  Write-Step "detected target: $target"
  Assert-GitBashRequirement
  $handsLatest = $null
  $handsChannel = $null

  if (-not $Version) {
    # Selection channel: explicit env wins; otherwise a previously persisted
    # channel keeps re-installs on the machine's chosen track — the same file
    # the runtime updater reads, so installer and updater can never disagree.
    $selectChannel = $InstallChannel
    if (-not $selectChannel) {
      $persistedChannelFile = Join-Path (Join-Path $StateHome 'computer') 'channel'
      if (Test-Path -LiteralPath $persistedChannelFile) {
        $persisted = (Get-Content -LiteralPath $persistedChannelFile -Raw).Trim()
        if ($persisted -match '^(latest|alpha|pinned:\d+\.\d+\.\d+(?:-[A-Za-z0-9_.-]+)?)$') {
          $selectChannel = $persisted
        } elseif ($persisted) {
          Write-Step "ignoring invalid persisted release channel '$persisted'"
        }
      }
    }
    if ($selectChannel -and $selectChannel.StartsWith('pinned:')) {
      # A pin selects an exact version; Hands still attests its identity.
      $Version = $selectChannel.Substring(7)
    } else {
      $handsChannel = if ($selectChannel -eq 'alpha') { 'alpha' } else { 'main' }
      $handsUrl = "$HandsOrigin/public/v2/apps/$HandsApp/latest?channel=$handsChannel&product_type=cli-binary"
      Write-Step "resolving the active $handsChannel release from Hands ($HandsApp)"
      try {
        $handsLatest = Read-Json $handsUrl
      } catch {
        Fail "could not resolve the active $handsChannel release from Hands ($handsUrl): $($_.Exception.Message). Refusing to install without the release authority (no CDN-pointer fallback)"
      }
      $Version = $handsLatest.build.version
      if (-not $Version) { Fail "Hands $handsChannel response for $HandsApp carried no build version; refusing to continue" }
    }
  }
  if (-not $Version) { Fail "invalid release version: $Version" }
  ConvertTo-SemVer $Version 'target release' | Out-Null

  $destination = Join-Path $InstallDir $BinaryName
  $needsLegacyMigration = Test-LegacyComputerState $destination
  if (Test-Path -LiteralPath $destination) {
    $dispatcherVersion = Get-BinarySelfVersion $destination
    $residentVersion = Get-BinaryResidentVersion $destination
    ConvertTo-SemVer $dispatcherVersion "PATH dispatcher at $destination" | Out-Null
    ConvertTo-SemVer $residentVersion "effective K stable reached through $destination" | Out-Null
    if ($dispatcherVersion -eq $Version) {
      Write-Step "PATH dispatcher already reports v$Version from its own bytes; verifying and reinstalling the exact immutable candidate"
    }
    if (-not $Force) {
      if (Refuse-NewerVersion "PATH dispatcher at $destination" $dispatcherVersion $Version) { return }
      if (Refuse-NewerVersion "effective K stable reached through $destination" $residentVersion $Version) { return }
    }
  }

  if (-not $handsLatest -and $env:RAFT_COMPUTER_RELEASE_BACKEND -ne 'legacy-cdn') {
    $handsChannel = "pinned:$Version"
    $encodedVersion = [Uri]::EscapeDataString($Version)
    $targetParts = @($target -split '-', 2)
    $handsUrl = "$HandsOrigin/public/v2/apps/$HandsApp/updates/check?product_type=cli-binary&current_version=0.0.0&channel=main&platform=$($targetParts[0])&arch=$($targetParts[1])&sdk_version=0.5.1&version=$encodedVersion"
    try { $pinned = Read-Json $handsUrl }
    catch { Fail "could not attest pinned $Version with Hands; refusing before CDN download" }
    if ($pinned.update_available -ne $true -or $pinned.release.version -ne $Version) { Fail 'Hands returned a different pinned version; refusing before CDN download' }
    $handsLatest = @{ assets = @(@{ platform = $targetParts[0]; arch = $targetParts[1]; filetype = 'binary'; variant = $null; sha256 = $pinned.artifact.sha256; size_bytes = $pinned.artifact.size_bytes }) }
  }

  $base = "$ReleaseBase/$Version"
  Write-Step "fetching manifest $base/manifest.json"
  $manifest = Read-Json "$base/manifest.json"
  if ($manifest.version -ne $Version) { Fail "manifest version '$($manifest.version)' does not match requested '$Version'" }
  $entry = $manifest.targets.$target
  if (-not $entry) { Fail "target $target is not present in the release manifest" }
  Assert-HandsManifestTargetIdentity $handsLatest $target $entry $Version $handsChannel $HandsApp
  $photonWasm = $manifest.photonWasm
  if (-not $photonWasm -or $photonWasm.file -ne $PhotonWasmName -or -not $photonWasm.sha256) {
    Fail "manifest missing photonWasm sidecar for image processing"
  }
  $file = $entry.file
  if (-not $file -or [System.IO.Path]::GetFileName($file) -ne $file -or $file -notmatch '^raft-computer-win32-(x64|arm64)\.exe$') {
    Fail "invalid Windows asset name in manifest: $file"
  }

  $tempDir = Join-Path $env:TEMP ("raft-computer-install-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDir | Out-Null
  try {
    $downloadedBinary = Join-Path $tempDir $file
    if ($entry.gz -and $entry.gz.file -and $entry.gz.sha256) {
      $gzipFile = $entry.gz.file
      if ([System.IO.Path]::GetFileName($gzipFile) -ne $gzipFile -or $gzipFile -ne "$file.gz") {
        Fail "invalid gzip asset name in manifest: $gzipFile"
      }
      $downloadedGzip = Join-Path $tempDir $gzipFile
      Write-Step "downloading $base/$gzipFile"
      Invoke-Download "$base/$gzipFile" $downloadedGzip
      Test-Sha256 $downloadedGzip $entry.gz.sha256
      Write-Step 'compressed sha256 verified; decompressing'
      Expand-Gzip $downloadedGzip $downloadedBinary
    } else {
      Write-Step "downloading $base/$file"
      Invoke-Download "$base/$file" $downloadedBinary
    }
    Test-Sha256 $downloadedBinary $entry.sha256
    Assert-PeTarget $downloadedBinary $target
    $candidateVersion = Get-BinarySelfVersion $downloadedBinary
    if ($candidateVersion -ne $Version) {
      Fail "verified candidate reported version '$candidateVersion', expected '$Version'"
    }
    Write-Step "binary sha256 and PE architecture verified ($target)"
    $downloadedPhotonWasm = Join-Path $tempDir $PhotonWasmName
    Write-Step "downloading $base/$PhotonWasmName (image processing resource)"
    Invoke-Download "$base/$PhotonWasmName" $downloadedPhotonWasm
    Test-Sha256 $downloadedPhotonWasm $photonWasm.sha256
    Write-Step 'image processing resource sha256 verified'

    # K consumes these exact manifest-verified local bytes before any install
    # directory mutation. The hidden candidate-only mode owns the K lock,
    # service readback, promotion, receipt, and downgrade policy.
    if (Test-Path -LiteralPath $KStateDir -PathType Container) {
      $convergeArgs = @('__installer-converge', $Version, $entry.sha256.ToLowerInvariant())
      if ($Force) { $convergeArgs += '--force-downgrade' }
      $convergeOutput = @(& $downloadedBinary @convergeArgs 2>&1)
      $convergeExit = $LASTEXITCODE
      if ($convergeExit -ne 0) {
        Fail "K stable convergence failed before dispatcher publish: $($convergeOutput -join ' ')"
      }
      $convergeResult = if ($convergeOutput.Count -gt 0) {
        $convergeOutput[$convergeOutput.Count - 1].ToString().Trim()
      } else { '' }
      switch ($convergeResult) {
        'converged' { $script:KEffectiveTarget = $Version }
        'not-initialized' {}
        default { Fail "K convergence returned an invalid result: $convergeResult" }
      }
    }

    Install-PhotonWasm $downloadedPhotonWasm (Join-Path $InstallDir $PhotonWasmName) $photonWasm.sha256
    Install-Binary $downloadedBinary $destination $Version $entry.sha256
    $script:KEffectiveTarget = $null
    Persist-InstallChannel
    Add-ToUserPath $InstallDir
    if ($needsLegacyMigration) {
      Retire-LegacySupervisor $destination
    }
    Write-Step "installed to $destination"
    Write-Step "done - run: $CommandName --version"
  } finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
