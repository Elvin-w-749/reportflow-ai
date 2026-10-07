Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-LegacyAnalysisV4RepoRoot {
  return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Get-LegacyAnalysisV4TmpRoot {
  $repoRoot = Get-LegacyAnalysisV4RepoRoot
  return [IO.Path]::GetFullPath((Join-Path $repoRoot 'tmp'))
}

function Test-PathBelowRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $full = [IO.Path]::GetFullPath($Path)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  return $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$StopAt
  )

  $stop = [IO.Path]::GetFullPath($StopAt).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $currentPath = (Get-Item -LiteralPath $Path -Force -ErrorAction Stop).FullName
  while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
    $cursor = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Private runtime paths cannot traverse a reparse point.'
    }
    $current = $cursor.FullName.TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    )
    if ($current -ieq $stop) { return }
    $parentPath = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $current) { break }
    $currentPath = $parentPath
  }
  throw 'Private runtime path does not reach the expected root.'
}

function Resolve-LegacyAnalysisV4RuntimeDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$MustExist
  )

  $tmpRoot = Get-LegacyAnalysisV4TmpRoot
  $full = [IO.Path]::GetFullPath($Path).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $parent = [IO.Path]::GetFullPath((Split-Path -Parent $full)).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $leaf = Split-Path -Leaf $full

  if ($parent -ine $tmpRoot.TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    )) {
    throw 'The v4 private runtime must be a direct child of the repository tmp directory.'
  }
  if ($leaf -notmatch '^real-analysis-v4-[a-z0-9][a-z0-9-]{5,63}$') {
    throw 'The v4 private runtime directory name is invalid.'
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $full -PathType Container)) {
    throw 'The v4 private runtime directory is unavailable.'
  }
  if (Test-Path -LiteralPath $full) {
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
      throw 'The v4 private runtime path is not a directory.'
    }
    Assert-NoReparsePath -Path $full -StopAt $tmpRoot
  } elseif (Test-Path -LiteralPath $tmpRoot -PathType Container) {
    Assert-NoReparsePath -Path $tmpRoot -StopAt $tmpRoot
  }
  return $full
}

function Set-LegacyAnalysisOwnerOnlyAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not [OperatingSystem]::IsWindows()) {
    throw 'Owner-only runtime ACL setup requires Windows.'
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Owner-only ACLs cannot be applied to a reparse point.'
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $grant = if ($item.PSIsContainer) {
    ('*{0}:(OI)(CI)F' -f $sid.Value)
  } else {
    ('*{0}:F' -f $sid.Value)
  }
  $aclOutput = @(& icacls.exe $item.FullName '/inheritance:r' '/grant:r' $grant 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $aclOutput = $null
    throw 'Owner-only ACL application failed.'
  }
  $aclOutput = $null
  $ownerOutput = @(& icacls.exe $item.FullName '/setowner' $identity.Name 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $ownerOutput = $null
    throw 'Owner-only ACL ownership assignment failed.'
  }
  $ownerOutput = $null
  $security = Get-Acl -LiteralPath $item.FullName
  $rules = @($security.GetAccessRules(
      $true,
      $true,
      [Security.Principal.SecurityIdentifier]
    ))
  $removals = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($rule in $rules) {
    $identitySid = $rule.IdentityReference.Value
    $removeMode = if (
      $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny
    ) {
      '/remove:d'
    } else {
      '/remove:g'
    }
    if ($identitySid -eq $sid.Value -and $removeMode -eq '/remove:g') {
      continue
    }
    [void]$removals.Add(('{0}|{1}' -f $removeMode, $identitySid))
  }
  foreach ($removal in $removals) {
    $removeMode, $identitySid = $removal.Split('|', 2)
    $removeOutput = @(& icacls.exe $item.FullName $removeMode ('*{0}' -f $identitySid) 2>&1)
    if ($LASTEXITCODE -ne 0) {
      $removeOutput = $null
      throw 'Owner-only ACL removal of an external rule failed.'
    }
    $removeOutput = $null
  }
}

function Assert-LegacyAnalysisOwnerOnlyAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = Get-Acl -LiteralPath $item.FullName
  $ownerSid = ([Security.Principal.NTAccount]$security.Owner).Translate(
    [Security.Principal.SecurityIdentifier]
  )
  if ($ownerSid.Value -ne $sid.Value -or -not $security.AreAccessRulesProtected) {
    throw 'Private runtime ACL ownership or inheritance is invalid.'
  }
  $rules = @($security.GetAccessRules(
      $true,
      $true,
      [Security.Principal.SecurityIdentifier]
    ))
  if ($rules.Count -eq 0) {
    throw 'Private runtime ACL has no owner access rule.'
  }
  foreach ($rule in $rules) {
    if (
      $rule.IdentityReference.Value -ne $sid.Value -or
      $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $rule.IsInherited
    ) {
      throw 'Private runtime ACL grants access outside the current owner.'
    }
  }
  $fullControl = @($rules | Where-Object {
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq
        [Security.AccessControl.FileSystemRights]::FullControl
    })
  if ($fullControl.Count -eq 0) {
    throw 'Private runtime ACL does not grant full control to the current owner.'
  }
}

function Resolve-LegacyAnalysisV4RuntimeFile {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Suffix,
    [switch]$MustExist
  )

  $runtime = Resolve-LegacyAnalysisV4RuntimeDirectory -Path $RuntimeDirectory -MustExist
  $full = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetFullPath((Split-Path -Parent $full)).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  if ($parent -ine $runtime) {
    throw 'All v4 runtime control files must share the owner-only runtime directory.'
  }
  if (-not $full.EndsWith($Suffix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A v4 runtime control file has an invalid suffix.'
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $full -PathType Leaf)) {
    throw 'A required v4 runtime control file is unavailable.'
  }
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'A v4 runtime control file cannot be a reparse point.'
    }
  }
  return $full
}

function Write-LegacyAnalysisPrivateJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $parent = Split-Path -Parent $Path
  $temporary = Join-Path $parent ('.write-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $json = $Value | ConvertTo-Json -Depth 64
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Set-LegacyAnalysisOwnerOnlyAcl -Path $temporary
    [IO.File]::Move($temporary, $Path, $true)
    Set-LegacyAnalysisOwnerOnlyAcl -Path $Path
    Assert-LegacyAnalysisOwnerOnlyAcl -Path $Path
  } finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Read-LegacyAnalysisV4Control {
  param([Parameter(Mandatory = $true)][string]$RuntimeDirectory)

  $runtime = Resolve-LegacyAnalysisV4RuntimeDirectory -Path $RuntimeDirectory -MustExist
  Assert-LegacyAnalysisOwnerOnlyAcl -Path $runtime
  $controlPath = Resolve-LegacyAnalysisV4RuntimeFile `
    -RuntimeDirectory $runtime `
    -Path (Join-Path $runtime 'runtime-control.private.json') `
    -Suffix '.private.json' `
    -MustExist
  Assert-LegacyAnalysisOwnerOnlyAcl -Path $controlPath
  $control = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json -DateKind String
  $properties = @($control.PSObject.Properties.Name | Sort-Object)
  $expected = @('createdAt', 'expiresAt', 'kind', 'runtimeId', 'version') | Sort-Object
  if (@(Compare-Object -ReferenceObject $expected -DifferenceObject $properties).Count -ne 0) {
    throw 'The v4 private runtime control schema is invalid.'
  }
  if (
    [int]$control.version -ne 1 -or
    [string]$control.kind -ne 'rpt-legacy-analysis-v4-private-runtime' -or
    [string]$control.runtimeId -notmatch '^[0-9a-f]{32}$'
  ) {
    throw 'The v4 private runtime control identity is invalid.'
  }
  $created = [DateTimeOffset]::ParseExact(
    [string]$control.createdAt,
    'o',
    [Globalization.CultureInfo]::InvariantCulture
  )
  $expires = [DateTimeOffset]::ParseExact(
    [string]$control.expiresAt,
    'o',
    [Globalization.CultureInfo]::InvariantCulture
  )
  if ($expires -le $created -or $expires -gt $created.AddDays(7)) {
    throw 'The v4 private runtime TTL is invalid.'
  }
  return $control
}

function Get-LegacyAnalysisV4ActiveProcesses {
  param([Parameter(Mandatory = $true)][string]$RuntimeDirectory)

  $runtime = Resolve-LegacyAnalysisV4RuntimeDirectory -Path $RuntimeDirectory -MustExist
  $processMatches = [Collections.Generic.List[object]]::new()
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ([int]$process.ProcessId -eq $PID) { continue }
    $name = [string]$process.Name
    $commandLine = [string]$process.CommandLine
    if (
      $name -notmatch '^node(\.exe)?$' -or
      [string]::IsNullOrWhiteSpace($commandLine) -or
      $commandLine.IndexOf($runtime, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
      $commandLine -notmatch '(?i)run-legacy-analysis-consistency\.mjs'
    ) {
      continue
    }
    $processMatches.Add([pscustomobject]@{
        ProcessId = [int]$process.ProcessId
        Name = $name
      })
  }
  return @($processMatches)
}

Export-ModuleMember -Function @(
  'Get-LegacyAnalysisV4RepoRoot',
  'Get-LegacyAnalysisV4TmpRoot',
  'Test-PathBelowRoot',
  'Assert-NoReparsePath',
  'Resolve-LegacyAnalysisV4RuntimeDirectory',
  'Set-LegacyAnalysisOwnerOnlyAcl',
  'Assert-LegacyAnalysisOwnerOnlyAcl',
  'Resolve-LegacyAnalysisV4RuntimeFile',
  'Write-LegacyAnalysisPrivateJson',
  'Read-LegacyAnalysisV4Control',
  'Get-LegacyAnalysisV4ActiveProcesses'
)
