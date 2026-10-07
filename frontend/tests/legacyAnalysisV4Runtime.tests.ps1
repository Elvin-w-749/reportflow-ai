$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tmpRoot = Join-Path $repoRoot 'tmp'
$caseId = [Guid]::NewGuid().ToString('N')
$sourceRoot = Join-Path $tmpRoot ('v4-runtime-safety-source-' + $caseId)
$runtime = Join-Path $tmpRoot ('real-analysis-v4-test-' + $caseId.Substring(0, 12))
$prepare = Join-Path $repoRoot 'scripts\prepare-legacy-analysis-v4-runtime.ps1'
$cleanup = Join-Path $repoRoot 'scripts\cleanup-legacy-analysis-v4-runtime.ps1'
$starter = Join-Path $repoRoot 'scripts\start-legacy-analysis-v4-runner.ps1'
$module = Join-Path $repoRoot 'scripts\legacy-analysis-v4-runtime.psm1'
Import-Module $module -Force

$results = [Collections.Generic.List[object]]::new()
function Add-Result([string]$Name, [bool]$Passed) {
  $results.Add([pscustomobject]@{ test = $Name; passed = $Passed })
}

function Write-MinimalPdf {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Marker
  )

  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append("%PDF-1.4`n%$Marker`n")
  $offsets = [Collections.Generic.List[int]]::new()
  foreach ($object in @(
      "1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj",
      "2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj",
      "3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources <<>> /Contents 4 0 R >>`nendobj",
      "4 0 obj`n<< /Length 0 >>`nstream`n`nendstream`nendobj"
    )) {
    $offsets.Add([Text.Encoding]::ASCII.GetByteCount($builder.ToString()))
    [void]$builder.Append($object + "`n")
  }
  $xrefOffset = [Text.Encoding]::ASCII.GetByteCount($builder.ToString())
  [void]$builder.Append("xref`n0 5`n0000000000 65535 f `n")
  foreach ($offset in $offsets) {
    [void]$builder.Append(('{0:D10} 00000 n ' -f $offset) + "`n")
  }
  [void]$builder.Append("trailer`n<< /Size 5 /Root 1 0 R >>`nstartxref`n$xrefOffset`n%%EOF`n")
  [IO.File]::WriteAllBytes($Path, [Text.Encoding]::ASCII.GetBytes($builder.ToString()))
}

try {
  [IO.Directory]::CreateDirectory($sourceRoot) | Out-Null
  $files = [Collections.Generic.List[object]]::new()
  foreach ($number in 1..30) {
    $id = 'P{0:D2}' -f $number
    $path = Join-Path $sourceRoot ('source-' + $number + '.pdf')
    Write-MinimalPdf -Path $path -Marker ('source-' + $number)
    $focus = $number -le 21
    $files.Add([pscustomobject][ordered]@{
        id = $id
        path = $path
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        targetRuns = if ($focus) { 5 } else { 3 }
        tags = if ($focus) { @('credit-utilization') } else { @('baseline') }
        pageCount = 1
        textChars = 1
      })
  }
  $scanPath = Join-Path $sourceRoot 'newest-sensitive-name.pdf'
  Write-MinimalPdf -Path $scanPath -Marker 'scan-31'
  $manifestPath = Join-Path $sourceRoot 'source-manifest.private.json'
  [IO.File]::WriteAllText(
    $manifestPath,
    ([pscustomobject]@{ version = 1; files = @($files) } | ConvertTo-Json -Depth 16),
    [Text.UTF8Encoding]::new($false)
  )
  $sourceHashesBefore = @($files.path + $scanPath | ForEach-Object {
      (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
    })

  $prepared = & $prepare `
    -SourceManifest $manifestPath `
    -ScanPdf $scanPath `
    -RuntimeDirectory $runtime `
    -TtlHours 1
  Add-Result 'prepare_counts' (
    $prepared.prepared -eq $true -and
    $prepared.anonymousReports -eq 31 -and
    $prepared.plannedSuccessfulRuns -eq 137 -and
    $prepared.scanRuns -eq 5 -and
    $prepared.tokenPersisted -eq $false
  )

  $privateManifestPath = Join-Path $runtime 'manifest.private.json'
  $privateManifestRaw = Get-Content -LiteralPath $privateManifestPath -Raw
  $privateManifest = $privateManifestRaw | ConvertFrom-Json -DateKind String
  $anonymousLeafNames = @($privateManifest.files | ForEach-Object {
      Split-Path -Leaf ([string]$_.path)
    } | Sort-Object)
  $expectedLeafNames = 1..31 | ForEach-Object { 'P{0:D2}.pdf' -f $_ }
  Add-Result 'anonymous_copy_names_only' (
    @(Compare-Object $expectedLeafNames $anonymousLeafNames).Count -eq 0 -and
    $privateManifestRaw -notmatch 'source-' -and
    $privateManifestRaw -notmatch 'newest-sensitive-name'
  )
  $scanEntry = @($privateManifest.files | Where-Object id -eq 'P31')[0]
  Add-Result 'scan_manifest_contract' (
    [int]$scanEntry.targetRuns -eq 5 -and
    @($scanEntry.tags).Count -eq 1 -and
    [string]$scanEntry.tags[0] -eq 'scanned-pdf' -and
    -not ($scanEntry.PSObject.Properties.Name -contains 'pageCount') -and
    -not ($scanEntry.PSObject.Properties.Name -contains 'textChars')
  )

  $aclPassed = $true
  try {
    Assert-LegacyAnalysisOwnerOnlyAcl -Path $runtime
    foreach ($item in @(Get-ChildItem -LiteralPath $runtime -Recurse -Force)) {
      Assert-LegacyAnalysisOwnerOnlyAcl -Path $item.FullName
    }
  } catch {
    $aclPassed = $false
  }
  Add-Result 'owner_only_acl_everywhere' $aclPassed

  $aclProbe = Join-Path $runtime 'acl-external-rule-probe.tmp'
  [IO.File]::WriteAllText($aclProbe, 'acl-probe', [Text.UTF8Encoding]::new($false))
  & icacls.exe $aclProbe '/grant' '*S-1-5-32-544:F' | Out-Null
  $externalRuleAdded = $LASTEXITCODE -eq 0
  $externalRuleRemoved = $false
  try {
    Set-LegacyAnalysisOwnerOnlyAcl -Path $aclProbe
    Assert-LegacyAnalysisOwnerOnlyAcl -Path $aclProbe
    $externalRuleRemoved = $true
  } catch {
    $externalRuleRemoved = $false
  }
  Add-Result 'external_acl_rules_removed' ($externalRuleAdded -and $externalRuleRemoved)

  $youngRejected = $false
  try {
    & $cleanup -RuntimeDirectory $runtime -Confirm:$false | Out-Null
  } catch {
    $youngRejected = $true
  }
  Add-Result 'ttl_blocks_early_cleanup' ($youngRejected -and (Test-Path -LiteralPath $runtime))

  $starterText = Get-Content -LiteralPath $starter -Raw
  Add-Result 'stdin_token_never_persisted' (
    $starterText -match '\[Console\]::IsInputRedirected' -and
    $starterText -match '\[Console\]::In\.ReadToEnd' -and
    $starterText -match 'RPT_LEGACY_TOKEN' -and
    $starterText -notmatch '(?i)TokenFile|ConvertFrom-SecureString|ConvertTo-SecureString'
  )
  Add-Result 'control_arguments_forwarded' (
    $starterText -match "'--request-ledger'" -and
    $starterText -notmatch "'--shared-ledger'|'--instance-lock'" -and
    $starterText -match "'--only-id'" -and
    $starterText -match "'--stop-after-new-successes'"
  )

  $unsafeCleanupRejected = $false
  try {
    & $cleanup -RuntimeDirectory $sourceRoot -Force -Confirm:$false | Out-Null
  } catch {
    $unsafeCleanupRejected = $true
  }
  Add-Result 'cleanup_rejects_non_runtime_source' ($unsafeCleanupRejected -and (Test-Path $sourceRoot))

  $cleaned = & $cleanup -RuntimeDirectory $runtime -Force -Confirm:$false
  $sourceHashesAfter = @($files.path + $scanPath | ForEach-Object {
      (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
    })
  Add-Result 'cleanup_generated_only' (
    $cleaned.cleaned -eq $true -and
    $cleaned.sourceReportsTouched -eq $false -and
    -not (Test-Path -LiteralPath $runtime) -and
    @(Compare-Object $sourceHashesBefore $sourceHashesAfter -SyncWindow 0).Count -eq 0
  )
} finally {
  if (Test-Path -LiteralPath $runtime -PathType Container) {
    Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $sourceRoot -PathType Container) {
    Remove-Item -LiteralPath $sourceRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$failed = @($results | Where-Object { -not $_.passed })
$results | Format-Table -AutoSize
[pscustomobject]@{
  total = $results.Count
  passed = @($results | Where-Object passed).Count
  failed = $failed.Count
  networkCalls = 0
  sourceReportsModified = $false
} | Format-List
if ($failed.Count -gt 0) { exit 1 }
