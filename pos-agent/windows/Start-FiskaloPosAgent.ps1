[CmdletBinding()]
param([string]$AllowedOrigins = 'https://fiskalo.shqiptare.workers.dev')
$ErrorActionPreference = 'Stop'
$agent = Join-Path $PSScriptRoot 'Fiskalo.PosAgent.Host.exe'
if (-not (Test-Path -LiteralPath $agent -PathType Leaf)) { throw 'Agent executable missing. Reinstall from the complete Windows x64 package.' }
$splitOptions = [System.StringSplitOptions]::RemoveEmptyEntries -bor [System.StringSplitOptions]::TrimEntries
$originList = @($AllowedOrigins.Split(';', $splitOptions))
if ($originList.Count -eq 0) { throw 'At least one exact HTTPS origin is required.' }
foreach ($origin in $originList) {
  $parsed = $null
  if (-not [Uri]::TryCreate($origin, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -ne 'https' -or $parsed.AbsolutePath -ne '/' -or $parsed.Query -or $parsed.Fragment) { throw ('Invalid allowed origin: ' + $origin) }
}
$env:FISKALO_ALLOWED_ORIGINS = ($originList -join ';')
Write-Host 'Starting Fiskalo POS Agent. Keep this window open while using the local POS connection.'
Write-Host ('Allowed browser origins: ' + $env:FISKALO_ALLOWED_ORIGINS)
Write-Host 'The one-time pairing code below is a secret. Do not share it.'
& $agent
exit $LASTEXITCODE