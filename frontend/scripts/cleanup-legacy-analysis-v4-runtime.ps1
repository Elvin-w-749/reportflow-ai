[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
  [switch]$Force,
  [switch]$TerminateActiveRunner
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'legacy-analysis-v4-runtime.psm1') -Force

$runtime = Resolve-LegacyAnalysisV4RuntimeDirectory -Path $RuntimeDirectory -MustExist
$control = Read-LegacyAnalysisV4Control -RuntimeDirectory $runtime
$expiresAt = [DateTimeOffset]::ParseExact(
  [string]$control.expiresAt,
  'o',
  [Globalization.CultureInfo]::InvariantCulture
)
if (-not $Force -and [DateTimeOffset]::UtcNow -lt $expiresAt) {
  throw 'The v4 private runtime TTL has not expired.'
}

$active = @(Get-LegacyAnalysisV4ActiveProcesses -RuntimeDirectory $runtime)
if ($active.Count -gt 0 -and -not $TerminateActiveRunner) {
  throw 'An active v4 runner still references this private runtime.'
}
if ($active.Count -gt 0) {
  foreach ($process in @($active | Sort-Object ProcessId -Descending)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
  }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $active = @(Get-LegacyAnalysisV4ActiveProcesses -RuntimeDirectory $runtime)
  } while ($active.Count -gt 0 -and [DateTimeOffset]::UtcNow -lt $deadline)
  if ($active.Count -gt 0) {
    throw 'An active v4 runner could not be terminated safely.'
  }
}

$allItems = @(Get-ChildItem -LiteralPath $runtime -Recurse -Force -ErrorAction Stop)
if (@($allItems | Where-Object {
      ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    }).Count -ne 0) {
  throw 'The v4 private runtime contains a reparse point and cannot be cleaned recursively.'
}
foreach ($item in $allItems) {
  Assert-LegacyAnalysisOwnerOnlyAcl -Path $item.FullName
}
Assert-LegacyAnalysisOwnerOnlyAcl -Path $runtime

$manifestPath = Join-Path $runtime 'manifest.private.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'The bound anonymous manifest is unavailable; cleanup is refused.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -DateKind String
$ids = @($manifest.files | ForEach-Object { [string]$_.id } | Sort-Object)
$expectedIds = 1..31 | ForEach-Object { 'P{0:D2}' -f $_ }
if (@(Compare-Object -ReferenceObject $expectedIds -DifferenceObject $ids).Count -ne 0) {
  throw 'The bound anonymous manifest is invalid; cleanup is refused.'
}
$inputs = [IO.Path]::GetFullPath((Join-Path $runtime 'inputs'))
foreach ($file in @($manifest.files)) {
  $path = [IO.Path]::GetFullPath([string]$file.path)
  $parent = [IO.Path]::GetFullPath((Split-Path -Parent $path))
  if (
    $parent -ine $inputs -or
    (Split-Path -Leaf $path) -ine ([string]$file.id + '.pdf')
  ) {
    throw 'The bound anonymous manifest points outside its generated input directory.'
  }
}

$quarantine = Join-Path (Split-Path -Parent $runtime) (
  '.real-analysis-v4-cleanup-' + [string]$control.runtimeId
)
if (Test-Path -LiteralPath $quarantine) {
  throw 'A private cleanup quarantine collision was detected.'
}

if ($PSCmdlet.ShouldProcess('the validated owner-only v4 private runtime', 'secure cleanup')) {
  [IO.Directory]::Move($runtime, $quarantine)
  $tmpRoot = Get-LegacyAnalysisV4TmpRoot
  $quarantineFull = [IO.Path]::GetFullPath($quarantine)
  if (-not (Test-PathBelowRoot -Path $quarantineFull -Root $tmpRoot)) {
    throw 'The private cleanup quarantine escaped repository tmp.'
  }
  $quarantineItems = @(Get-ChildItem -LiteralPath $quarantineFull -Recurse -Force -ErrorAction Stop)
  if (@($quarantineItems | Where-Object {
        ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
      }).Count -ne 0) {
    throw 'The private cleanup quarantine contains a reparse point.'
  }
  Remove-Item -LiteralPath $quarantineFull -Recurse -Force -ErrorAction Stop
  if ((Test-Path -LiteralPath $runtime) -or (Test-Path -LiteralPath $quarantineFull)) {
    throw 'The v4 private runtime cleanup did not finish.'
  }
  [pscustomobject]@{
    cleaned = $true
    generatedRuntimeRemoved = $true
    sourceReportsTouched = $false
    residualArtifacts = 0
  }
}
