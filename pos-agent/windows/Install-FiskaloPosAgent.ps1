[CmdletBinding()]
param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\Fiskalo POS Agent'), [switch]$StartAgent)
$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $source 'Fiskalo.PosAgent.Host.exe') -PathType Leaf)) { throw 'Run this installer from the extracted fiskalo-pos-agent-win-x64 package.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Fiskalo POS Agent currently requires 64-bit Windows.' }
New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -ne 'Install-FiskaloPosAgent.ps1' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $InstallDirectory -Recurse -Force }
$launcher = Join-Path $InstallDirectory 'Start-FiskaloPosAgent.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Launcher missing. Download the complete latest artifact.' }
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fiskalo POS Agent.lnk'
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy RemoteSigned -File ' + [char]34 + $launcher + [char]34
$shortcut.WorkingDirectory = $InstallDirectory
$shortcut.Description = 'Start the local Fiskalo POS Agent'
$shortcut.Save()
Write-Host ('Installed to: ' + $InstallDirectory)
Write-Host ('Desktop shortcut created: ' + $shortcutPath)
Write-Host 'The agent is not a Windows service and does not start automatically.'
if ($StartAgent) { & $launcher }