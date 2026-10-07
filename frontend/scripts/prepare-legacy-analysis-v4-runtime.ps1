[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceManifest,
  [Parameter(Mandatory = $true)][string]$ScanPdf,
  [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
  [ValidateRange(1, 168)][int]$TtlHours = 48
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'legacy-analysis-v4-runtime.psm1') -Force

$runtime = Resolve-LegacyAnalysisV4RuntimeDirectory -Path $RuntimeDirectory
if (Test-Path -LiteralPath $runtime) {
  throw 'The v4 private runtime directory already exists.'
}

$repoRoot = Get-LegacyAnalysisV4RepoRoot
$tmpRoot = Get-LegacyAnalysisV4TmpRoot
$sourceManifestPath = [IO.Path]::GetFullPath($SourceManifest)
if (
  -not (Test-PathBelowRoot -Path $sourceManifestPath -Root $tmpRoot) -or
  -not $sourceManifestPath.EndsWith('.private.json', [StringComparison]::OrdinalIgnoreCase) -or
  -not (Test-Path -LiteralPath $sourceManifestPath -PathType Leaf)
) {
  throw 'The source manifest must be an existing private manifest below repository tmp.'
}
Assert-NoReparsePath -Path $sourceManifestPath -StopAt $tmpRoot

$scanPath = [IO.Path]::GetFullPath($ScanPdf)
if (
  -not $scanPath.EndsWith('.pdf', [StringComparison]::OrdinalIgnoreCase) -or
  -not (Test-Path -LiteralPath $scanPath -PathType Leaf)
) {
  throw 'The additional scanned PDF is unavailable.'
}
$scanItem = Get-Item -LiteralPath $scanPath -Force
if (($scanItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'The additional scanned PDF cannot be a reparse point.'
}

$source = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json -DateKind String
if ([int]$source.version -ne 1 -or @($source.files).Count -ne 30) {
  throw 'The source manifest is not the approved 30-report batch.'
}
$expectedIds = 1..30 | ForEach-Object { 'P{0:D2}' -f $_ }
$actualIds = @($source.files | ForEach-Object { [string]$_.id } | Sort-Object)
if (@(Compare-Object -ReferenceObject $expectedIds -DifferenceObject $actualIds).Count -ne 0) {
  throw 'The source manifest anonymous ID set is invalid.'
}
if (
  @($actualIds | Group-Object | Where-Object Count -ne 1).Count -ne 0 -or
  [int](($source.files | Measure-Object targetRuns -Sum).Sum) -ne 132 -or
  @($source.files | Where-Object { [int]$_.targetRuns -eq 5 }).Count -ne 21 -or
  @($source.files | Where-Object { [int]$_.targetRuns -eq 3 }).Count -ne 9
) {
  throw 'The source manifest run distribution is invalid.'
}

$created = $false
try {
  [IO.Directory]::CreateDirectory($runtime) | Out-Null
  $created = $true
  Set-LegacyAnalysisOwnerOnlyAcl -Path $runtime
  Assert-LegacyAnalysisOwnerOnlyAcl -Path $runtime

  $inputs = Join-Path $runtime 'inputs'
  [IO.Directory]::CreateDirectory($inputs) | Out-Null
  Set-LegacyAnalysisOwnerOnlyAcl -Path $inputs
  Assert-LegacyAnalysisOwnerOnlyAcl -Path $inputs

  $preparedFiles = [Collections.Generic.List[object]]::new()
  foreach ($file in @($source.files | Sort-Object id)) {
    $id = [string]$file.id
    if ($id -notmatch '^P(?:0[1-9]|[12][0-9]|30)$') {
      throw 'The source manifest contains an invalid anonymous ID.'
    }
    $sourcePath = [IO.Path]::GetFullPath([string]$file.path)
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw 'An approved anonymous source PDF is unavailable.'
    }
    $sourceItem = Get-Item -LiteralPath $sourcePath -Force
    if (
      -not $sourcePath.EndsWith('.pdf', [StringComparison]::OrdinalIgnoreCase) -or
      ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
      throw 'An approved anonymous source PDF is invalid.'
    }
    $expectedHash = [string]$file.sha256
    if ($expectedHash -notmatch '^[0-9a-fA-F]{64}$') {
      throw 'An approved anonymous source PDF hash is invalid.'
    }
    $beforeHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($beforeHash -ne $expectedHash.ToLowerInvariant()) {
      throw 'An approved anonymous source PDF failed integrity validation.'
    }
    $tags = @($file.tags | ForEach-Object { [string]$_ })
    if (
      @($tags | Where-Object { $_ -notmatch '^[a-z0-9][a-z0-9-]{0,63}$' }).Count -ne 0 -or
      @($tags | Group-Object | Where-Object Count -ne 1).Count -ne 0 -or
      $tags -contains 'scanned-pdf'
    ) {
      throw 'An approved anonymous source classification is invalid.'
    }

    $destination = Join-Path $inputs ($id + '.pdf')
    [IO.File]::Copy($sourcePath, $destination, $false)
    Set-LegacyAnalysisOwnerOnlyAcl -Path $destination
    Assert-LegacyAnalysisOwnerOnlyAcl -Path $destination
    $copyHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    $afterHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($copyHash -ne $beforeHash -or $afterHash -ne $beforeHash) {
      throw 'An anonymous runtime copy failed integrity validation.'
    }
    $preparedFiles.Add([pscustomobject][ordered]@{
        id = $id
        path = $destination
        sha256 = $copyHash
        targetRuns = [int]$file.targetRuns
        tags = @($tags)
        pageCount = [int]$file.pageCount
        textChars = [long]$file.textChars
      })
  }

  $scanHashBefore = (Get-FileHash -LiteralPath $scanPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (@($preparedFiles | Where-Object sha256 -eq $scanHashBefore).Count -ne 0) {
    throw 'The additional scanned PDF duplicates an existing anonymous sample.'
  }
  $scanDestination = Join-Path $inputs 'P31.pdf'
  [IO.File]::Copy($scanPath, $scanDestination, $false)
  Set-LegacyAnalysisOwnerOnlyAcl -Path $scanDestination
  Assert-LegacyAnalysisOwnerOnlyAcl -Path $scanDestination
  $scanHashCopy = (Get-FileHash -LiteralPath $scanDestination -Algorithm SHA256).Hash.ToLowerInvariant()
  $scanHashAfter = (Get-FileHash -LiteralPath $scanPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($scanHashCopy -ne $scanHashBefore -or $scanHashAfter -ne $scanHashBefore) {
    throw 'The additional anonymous scan copy failed integrity validation.'
  }

  $preparedFiles.Add([pscustomobject][ordered]@{
      id = 'P31'
      path = $scanDestination
      sha256 = $scanHashCopy
      targetRuns = 5
      tags = @('scanned-pdf')
    })

  $manifest = [pscustomobject][ordered]@{
    version = 1
    files = @($preparedFiles | Sort-Object id)
  }
  $manifestPath = Join-Path $runtime 'manifest.private.json'
  Write-LegacyAnalysisPrivateJson -Path $manifestPath -Value $manifest

  $now = [DateTimeOffset]::UtcNow
  $control = [pscustomobject][ordered]@{
    version = 1
    kind = 'rpt-legacy-analysis-v4-private-runtime'
    runtimeId = [Guid]::NewGuid().ToString('N')
    createdAt = $now.ToString('o')
    expiresAt = $now.AddHours($TtlHours).ToString('o')
  }
  Write-LegacyAnalysisPrivateJson `
    -Path (Join-Path $runtime 'runtime-control.private.json') `
    -Value $control

  foreach ($item in @(Get-ChildItem -LiteralPath $runtime -Recurse -Force)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'The prepared private runtime contains an unexpected reparse point.'
    }
    Assert-LegacyAnalysisOwnerOnlyAcl -Path $item.FullName
  }

  [pscustomobject]@{
    prepared = $true
    anonymousReports = 31
    plannedSuccessfulRuns = 137
    scanRuns = 5
    ownerOnlyAcl = $true
    tokenPersisted = $false
  }
} catch {
  if ($created -and (Test-Path -LiteralPath $runtime -PathType Container)) {
    $safeToRemove = $false
    try {
      $resolved = Resolve-LegacyAnalysisV4RuntimeDirectory -Path $runtime -MustExist
      $reparseItems = @(Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction Stop | Where-Object {
          ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        })
      $safeToRemove = $reparseItems.Count -eq 0
    } catch {
      $safeToRemove = $false
    }
    if ($safeToRemove) {
      Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  throw
}
