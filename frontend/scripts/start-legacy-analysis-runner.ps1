param(
  [Parameter(Mandatory = $true)]
  [string]$TokenFile,
  [Parameter(Mandatory = $true)]
  [string]$Manifest,
  [Parameter(Mandatory = $true)]
  [string]$State,
  [Parameter(Mandatory = $true)]
  [string]$Summary
)

$ErrorActionPreference = 'Stop'
$encrypted = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
$secure = ConvertTo-SecureString $encrypted
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $env:RPT_LEGACY_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  Remove-Item -LiteralPath $TokenFile -Force -ErrorAction SilentlyContinue
  & node 'scripts\run-legacy-analysis-consistency.mjs' `
    --manifest $Manifest `
    --state $State `
    --summary $Summary `
    --confirm-live-legacy
  exit $LASTEXITCODE
} finally {
  Remove-Item Env:RPT_LEGACY_TOKEN -ErrorAction SilentlyContinue
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}
