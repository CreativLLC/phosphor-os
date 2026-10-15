<#
.SYNOPSIS
  Puts a Phosphor-OS look on Firefox (userChrome.css + userContent.css), or takes it off again.

.DESCRIPTION
  Install: backs up the profile's chrome folder and user.js to <profile>\phosphor-os-backup\<time>\,
  copies the theme into <profile>\chrome\, and turns on
  toolkit.legacyUserProfileCustomizations.stylesheets in user.js (Firefox ignores userChrome.css without it).
  Undo: puts back the newest backup and deletes it, so running -Undo again steps back one more install.
  Firefox reads these files when it starts: close it fully and reopen it to see the change.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-firefox-theme.ps1 -Theme retro-amber
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-firefox-theme.ps1 -Theme lcars -Profile "C:\path\to\profile"
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-firefox-theme.ps1 -Undo
#>
[CmdletBinding()]
param(
  [ValidateSet('retro-amber', 'retro-green', 'lcars')]
  [string]$Theme,
  # Named ProfilePath because $Profile is a PowerShell built-in; -Profile still works.
  [Alias('Profile')]
  [string]$ProfilePath,
  [switch]$Undo
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$PrefLine = 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Get-DefaultProfile {
  $root = Join-Path $env:APPDATA 'Mozilla\Firefox'
  $ini = Join-Path $root 'profiles.ini'
  if (-not (Test-Path -LiteralPath $ini)) { throw "No Firefox profiles.ini at $ini. Pass -Profile <folder>." }
  $section = ''
  $install = $null
  $profiles = [ordered]@{}
  foreach ($raw in [IO.File]::ReadAllLines($ini)) {
    $line = $raw.Trim()
    if ($line -match '^\[(.+)\]$') { $section = $Matches[1]; continue }
    if ($line -notmatch '^([^=]+)=(.*)$') { continue }
    $key = $Matches[1]
    $value = $Matches[2]
    if ($section -like 'Install*' -and $key -eq 'Default' -and -not $install) { $install = $value }
    if ($section -like 'Profile*') {
      if (-not $profiles.Contains($section)) { $profiles[$section] = @{} }
      $profiles[$section][$key] = $value
    }
  }
  # The [Install...] entry is the profile this Firefox install opens; older setups mark one profile Default=1.
  $path = $install
  if (-not $path) {
    foreach ($p in $profiles.Values) { if ($p['Default'] -eq '1') { $path = $p['Path']; break } }
  }
  if (-not $path -and $profiles.Count -eq 1) { $path = @($profiles.Values)[0]['Path'] }
  if (-not $path) { throw "Could not tell which Firefox profile is the default. Pass -Profile <folder>." }
  $path = $path -replace '/', '\'
  if (-not [IO.Path]::IsPathRooted($path)) { $path = Join-Path $root $path }
  return $path
}

function Write-UserJs([string]$file) {
  # Add the pref, or switch an existing line for it to true. Everything else in user.js stays as it is.
  $out = New-Object System.Collections.Generic.List[string]
  $found = $false
  if (Test-Path -LiteralPath $file) {
    foreach ($l in [IO.File]::ReadAllLines($file)) {
      if ($l -match 'toolkit\.legacyUserProfileCustomizations\.stylesheets') { $found = $true; $out.Add($PrefLine) } else { $out.Add($l) }
    }
  }
  if (-not $found) { $out.Add($PrefLine) }
  [IO.File]::WriteAllText($file, (($out -join "`n") + "`n"), $Utf8)
}

if (-not $Undo -and -not $Theme) { throw 'Pass -Theme retro-amber, retro-green or lcars (or -Undo).' }

if ($ProfilePath) { $prof = (Resolve-Path -LiteralPath $ProfilePath).Path } else { $prof = Get-DefaultProfile }
if (-not (Test-Path -LiteralPath $prof -PathType Container)) { throw "Profile folder not found: $prof" }

$chrome = Join-Path $prof 'chrome'
$userJs = Join-Path $prof 'user.js'
$backupRoot = Join-Path $prof 'phosphor-os-backup'
# Installed under the old name (Retro Claude)? Its backups stay where they are, and undo finds them there.
$oldRoot = Join-Path $prof 'retro-claude-backup'
if (-not (Test-Path -LiteralPath $backupRoot) -and (Test-Path -LiteralPath $oldRoot)) { $backupRoot = $oldRoot }
Write-Host "Firefox profile: $prof"

if ($Undo) {
  if (-not (Test-Path -LiteralPath $backupRoot)) { Write-Host 'Nothing to undo: no backup found.'; exit 1 }
  $last = Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object Name | Select-Object -Last 1
  if (-not $last) { Write-Host 'Nothing to undo: no backup found.'; exit 1 }
  $info = @{}
  foreach ($l in [IO.File]::ReadAllLines((Join-Path $last.FullName 'backup.info'))) {
    if ($l -match '^([^=]+)=(.*)$') { $info[$Matches[1]] = $Matches[2] }
  }
  if (Test-Path -LiteralPath $chrome) { Remove-Item -LiteralPath $chrome -Recurse -Force }
  if ($info['had_chrome'] -eq '1') { Copy-Item -LiteralPath (Join-Path $last.FullName 'chrome') -Destination $chrome -Recurse }
  if ($info['had_userjs'] -eq '1') {
    Copy-Item -LiteralPath (Join-Path $last.FullName 'user.js') -Destination $userJs -Force
  } elseif (Test-Path -LiteralPath $userJs) {
    Remove-Item -LiteralPath $userJs -Force
  }
  Remove-Item -LiteralPath $last.FullName -Recurse -Force
  if (-not (Get-ChildItem -LiteralPath $backupRoot -Force)) { Remove-Item -LiteralPath $backupRoot -Force }
  Write-Host "Restored the backup from $($last.Name). Restart Firefox to see it."
  exit 0
}

$src = Join-Path $Here $Theme
if (-not (Test-Path -LiteralPath (Join-Path $src 'userChrome.css'))) { throw "Theme files missing in $src" }

# Back up first; nothing is changed until the backup is complete.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $backupRoot $stamp
$n = 1
while (Test-Path -LiteralPath $dest) { $dest = Join-Path $backupRoot "$stamp-$n"; $n++ }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
$hadChrome = Test-Path -LiteralPath $chrome
$hadUserJs = Test-Path -LiteralPath $userJs
if ($hadChrome) { Copy-Item -LiteralPath $chrome -Destination (Join-Path $dest 'chrome') -Recurse }
if ($hadUserJs) { Copy-Item -LiteralPath $userJs -Destination (Join-Path $dest 'user.js') }
$infoText = "theme=$Theme`nhad_chrome=$([int]$hadChrome)`nhad_userjs=$([int]$hadUserJs)`n"
[IO.File]::WriteAllText((Join-Path $dest 'backup.info'), $infoText, $Utf8)

if ($hadChrome) { Remove-Item -LiteralPath $chrome -Recurse -Force }
New-Item -ItemType Directory -Path $chrome | Out-Null
Copy-Item -LiteralPath (Join-Path $src 'userChrome.css') -Destination $chrome
Copy-Item -LiteralPath (Join-Path $src 'userContent.css') -Destination $chrome
Copy-Item -LiteralPath (Join-Path $Here 'fonts') -Destination (Join-Path $chrome 'fonts') -Recurse
Write-UserJs $userJs

Write-Host "Installed $Theme. Backup: $dest"
if (Get-Process -Name firefox -ErrorAction SilentlyContinue) {
  Write-Host 'Firefox is running: close it fully and reopen it to see the theme.'
} else {
  Write-Host 'Start Firefox to see the theme.'
}
Write-Host 'Undo: run this script again with -Undo.'
