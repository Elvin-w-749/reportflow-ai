[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Manifest,

  [Parameter(Mandatory = $true)]
  [string]$State,

  [Parameter(Mandatory = $true)]
  [string]$Summary,

  [Parameter(Mandatory = $true)]
  [string]$RequestLedger
)

$ErrorActionPreference = 'Stop'

$validator = Join-Path $PSScriptRoot 'validate-legacy-analysis-consistency-v4.mjs'
if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
  throw 'The v4 validator is unavailable.'
}

# The Node core independently recomputes hashes, formulas, request order, and summary.
# This wrapper only passes quoted arguments and propagates the Node exit code.
[string[]]$nodeArguments = @(
  $validator,
  '--manifest', $Manifest,
  '--state', $State,
  '--summary', $Summary,
  '--request-ledger', $RequestLedger
)
$output = & node @nodeArguments
$nodeExitCode = $LASTEXITCODE

$output | Write-Output
# Preserve machine-readable JSON and propagate failures to callers.
# strictPass remains the only complete 31-report / 137-success release gate.
exit $nodeExitCode
