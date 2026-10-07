[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
  [string]$RunnerScript = '',
  [string]$Manifest = '',
  [string]$State = '',
  [string]$Summary = '',
  [string]$OutLog = '',
  [string]$ErrLog = '',
  [string]$RequestLedger = '',
  [ValidatePattern('^P(?:0[1-9]|[12][0-9]|3[01])$')][string]$OnlyId = '',
  [ValidateRange(1, 137)][int]$StopAfterNewSuccesses = 0,
  [switch]$ResumeAfterInflight,
  [switch]$ResumeAfterReview
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'legacy-analysis-v4-runtime.psm1') -Force

$runtime = Resolve-LegacyAnalysisV4RuntimeDirectory -Path $RuntimeDirectory -MustExist
$control = Read-LegacyAnalysisV4Control -RuntimeDirectory $runtime
if ([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::ParseExact(
    [string]$control.expiresAt,
    'o',
    [Globalization.CultureInfo]::InvariantCulture
  )) {
  throw 'The v4 private runtime has expired and must be cleaned up.'
}

$repoRoot = Get-LegacyAnalysisV4RepoRoot
$approvedRunner = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-legacy-analysis-consistency.mjs'))
$runner = if ([string]::IsNullOrWhiteSpace($RunnerScript)) {
  $approvedRunner
} else {
  [IO.Path]::GetFullPath($RunnerScript)
}
if ($runner -ine $approvedRunner -or -not (Test-Path -LiteralPath $runner -PathType Leaf)) {
  throw 'Only the approved legacy analysis runner can be launched.'
}
$runnerItem = Get-Item -LiteralPath $runner -Force
if (($runnerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'The approved legacy analysis runner cannot be a reparse point.'
}

$defaults = @{
  Manifest = 'manifest.private.json'
  State = 'state-v4.private.json'
  Summary = 'summary-v4.private.json'
  OutLog = 'runner-v4.out.private.log'
  ErrLog = 'runner-v4.err.private.log'
  RequestLedger = 'request-ledger-v4.private.jsonl'
}
foreach ($name in @($defaults.Keys)) {
  if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $name -ValueOnly))) {
    Set-Variable -Name $name -Value (Join-Path $runtime $defaults[$name])
  }
}

$manifestPath = Resolve-LegacyAnalysisV4RuntimeFile -RuntimeDirectory $runtime -Path $Manifest -Suffix '.private.json' -MustExist
$statePath = Resolve-LegacyAnalysisV4RuntimeFile -RuntimeDirectory $runtime -Path $State -Suffix '.private.json'
$summaryPath = Resolve-LegacyAnalysisV4RuntimeFile -RuntimeDirectory $runtime -Path $Summary -Suffix '.private.json'
$outLogPath = Resolve-LegacyAnalysisV4RuntimeFile -RuntimeDirectory $runtime -Path $OutLog -Suffix '.private.log'
$errLogPath = Resolve-LegacyAnalysisV4RuntimeFile -RuntimeDirectory $runtime -Path $ErrLog -Suffix '.private.log'
$requestLedgerPath = Resolve-LegacyAnalysisV4RuntimeFile -RuntimeDirectory $runtime -Path $RequestLedger -Suffix '.private.jsonl'
$allPaths = @(
  $manifestPath,
  $statePath,
  $summaryPath,
  $outLogPath,
  $errLogPath,
  $requestLedgerPath
)
if (($allPaths | Sort-Object -Unique).Count -ne $allPaths.Count) {
  throw 'All v4 runtime control paths must be distinct.'
}

if (-not [Console]::IsInputRedirected) {
  throw 'The authorization token must be supplied only through redirected standard input.'
}
$token = [Console]::In.ReadToEnd().Trim()
if (
  [string]::IsNullOrWhiteSpace($token) -or
  $token.Length -gt 16384 -or
  $token -match '\s'
) {
  $token = $null
  throw 'The standard-input authorization token is invalid.'
}

$child = $null
$childExitCode = 2
$childStarted = $false
$forcedStop = $false
try {
  [string[]]$nodeArguments = @(
    $runner,
    '--manifest', $manifestPath,
    '--state', $statePath,
    '--summary', $summaryPath,
    '--request-ledger', $requestLedgerPath,
    '--confirm-live-legacy'
  )
  if (-not [string]::IsNullOrWhiteSpace($OnlyId)) {
    $nodeArguments += @('--only-id', $OnlyId)
  }
  if ($StopAfterNewSuccesses -gt 0) {
    $nodeArguments += @('--stop-after-new-successes', [string]$StopAfterNewSuccesses)
  }
  if ($ResumeAfterInflight) { $nodeArguments += '--resume-after-inflight' }
  if ($ResumeAfterReview) { $nodeArguments += '--resume-after-review' }

  $quoteArgument = {
    param([string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
  }
  $argumentLine = ($nodeArguments | ForEach-Object { & $quoteArgument ([string]$_) }) -join ' '
  $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source

  try {
    $env:RPT_LEGACY_TOKEN = $token
    $child = Start-Process -FilePath $node -ArgumentList $argumentLine `
      -WorkingDirectory $repoRoot -WindowStyle Hidden `
      -RedirectStandardOutput $outLogPath -RedirectStandardError $errLogPath -PassThru
    $childStarted = $true
  } finally {
    Remove-Item Env:RPT_LEGACY_TOKEN -ErrorAction SilentlyContinue
    $token = $null
  }

  if ($null -eq $child) {
    throw 'The v4 legacy analysis runner did not start.'
  }
  $child.WaitForExit()
  $childExitCode = $child.ExitCode
} catch {
  if ($null -ne $child -and -not $child.HasExited) {
    $forcedStop = $true
    Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
    [void]$child.WaitForExit(10000)
  }
  throw
} finally {
  Remove-Item Env:RPT_LEGACY_TOKEN -ErrorAction SilentlyContinue
  $token = $null
  if ($childStarted -and (Test-Path -LiteralPath $runtime -PathType Container)) {
    foreach ($item in @(Get-ChildItem -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        continue
      }
      Set-LegacyAnalysisOwnerOnlyAcl -Path $item.FullName
      Assert-LegacyAnalysisOwnerOnlyAcl -Path $item.FullName
    }
    Set-LegacyAnalysisOwnerOnlyAcl -Path $runtime
    Assert-LegacyAnalysisOwnerOnlyAcl -Path $runtime
  }
  $residuals = @(Get-ChildItem -LiteralPath $runtime -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -match '(?i)token|credential|secret|\.tmp-|\.partial$'
    })
  if ($residuals.Count -gt 0) {
    [Console]::Error.WriteLine('[safety] private runtime residual scan requires review')
    if ($childExitCode -eq 0) { $childExitCode = 2 }
  }
  if ($forcedStop) {
    [Console]::Error.WriteLine('[safety] child was stopped; private runtime residual scan completed')
  }
}

exit $childExitCode
