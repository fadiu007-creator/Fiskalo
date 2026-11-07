[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Fiskalo POS Agent'))
$ErrorActionPreference = 'Stop'
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fiskalo POS Agent.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
$running = Get-Process -Name 'Fiskalo.PosAgent.Host' -ErrorAction SilentlyContinue
if ($running) { Write-Warning 'Close the Fiskalo POS Agent console window before removing its files.'; throw 'Agent is still running. No application files were removed.' }
if (Test-Path -LiteralPath $InstallDirectory) { Remove-Item -LiteralPath $InstallDirectory -Recurse -Force }
Write-Host 'Application files removed.'
Write-Host 'Protected local signing keys, certificates and fiscal queue data were intentionally retained under LocalAppData\Fiskalo\PosAgent.'
Write-Warning 'Local fiscal data was not deleted. Remove it only after an authorized backup and retention review.'