# Installs the Phosphor-OS desktop app runtime (Electron) and makes the desktop shortcut.
#
#   Runtime: Electron 44.4.5, Windows x64, the official zip from the electron/electron GitHub release
#   Where:   %LOCALAPPDATA%\PhosphorOS\shell\electron-44.4.5   (outside any synced folder: about 300 MB)
#   App:     shell\main.mjs in this project (the runtime just runs it)
#   Helper:  focus-app.exe, built here from shell\focus-app.cs (brings Firefox / Discord to the front)
#
# Run:   powershell -ExecutionPolicy Bypass -File scripts\setup-shell.ps1
#        Skips the download when this version is already installed. -Force reinstalls it.
#
# The zip is checked against the SHA-256 pinned below before it is unpacked. The same value is in
# the release's SHASUMS256.txt and in the npm package's checksums.json (both checked 2026-10-11).
# The download goes to a new empty folder that is deleted afterwards. No install scripts run.

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Version = '44.4.5'
$Url = "https://github.com/electron/electron/releases/download/v$Version/electron-v$Version-win32-x64.zip"
$Sha256 = '11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d'

$Project = Split-Path -Parent $PSScriptRoot
# Installed under the old name (Retro Claude)? Its RetroClaude folder is used while it is the only one.
$App = Join-Path $env:LOCALAPPDATA 'PhosphorOS'
$OldApp = Join-Path $env:LOCALAPPDATA 'RetroClaude'
if (-not (Test-Path -LiteralPath $App) -and (Test-Path -LiteralPath $OldApp)) { $App = $OldApp }
$Root = Join-Path $App 'shell'
$Dest = Join-Path $Root "electron-$Version"
$Exe = Join-Path $Dest 'electron.exe'

if ($Force -or -not (Test-Path $Exe)) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("phosphor-shell-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'electron.zip'
    "Downloading Electron $Version..."
    Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $Sha256) { throw "Hash mismatch for $Url`n expected $Sha256`n got      $got" }
    'Hash OK.'
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Force $Dest | Out-Null
    Expand-Archive -Path $zip -DestinationPath $Dest
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
  "Installed: $Exe"
} else {
  "Already installed: $Exe"
}

# focus-app.exe: brings Firefox / Discord to the front for the program buttons. Our own source
# (shell\focus-app.cs), built with the C# compiler that ships with Windows (.NET Framework 4).
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$focusSrc = Join-Path $Project 'shell\focus-app.cs'
$focusExe = Join-Path $Root 'focus-app.exe'
if ($Force -or -not (Test-Path $focusExe) -or (Get-Item $focusSrc).LastWriteTime -gt (Get-Item $focusExe).LastWriteTime) {
  if (-not (Test-Path $csc)) { throw "C# compiler not found: $csc" }
  & $csc /nologo /optimize /target:winexe "/out:$focusExe" $focusSrc
  if ($LASTEXITCODE -ne 0) { throw 'focus-app.exe did not build.' }
  "Built: $focusExe"
} else {
  "Already built: $focusExe"
}

# SYS panel helpers (our own source, same compiler): volume.exe reads and sets the PC volume; sysmon.exe reads
# CPU, GPU, network and drive counters for server/system.ts. sysmon.cs uses the audio code in volume.cs.
$volSrc = Join-Path $Project 'shell\volume.cs'
foreach ($h in @(@{ Exe = 'volume.exe'; Src = @($volSrc); Main = @() }, @{ Exe = 'sysmon.exe'; Src = @((Join-Path $Project 'shell\sysmon.cs'), $volSrc); Main = @('/main:SysMon') })) {
  $out = Join-Path $Root $h.Exe
  $newer = $h.Src | Where-Object { (Test-Path $out) -and (Get-Item $_).LastWriteTime -gt (Get-Item $out).LastWriteTime }
  if ($Force -or -not (Test-Path $out) -or $newer) {
    if (-not (Test-Path $csc)) { throw "C# compiler not found: $csc" }
    & $csc /nologo /optimize /target:winexe @($h.Main) "/out:$out" @($h.Src)
    if ($LASTEXITCODE -ne 0) { throw "$($h.Exe) did not build." }
    "Built: $out"
  } else {
    "Already built: $out"
  }
}

# Desktop shortcut "Phosphor-OS" -> the app. An older Edge shortcut of that name is kept as "Phosphor-OS (Edge)".
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path $desktop 'Phosphor-OS.lnk'
if (Test-Path $lnkPath) {
  $old = $shell.CreateShortcut($lnkPath)
  if ($old.TargetPath -match 'msedge') {
    $edgePath = Join-Path $desktop 'Phosphor-OS (Edge).lnk'
    if (-not (Test-Path $edgePath)) { Move-Item $lnkPath $edgePath } else { Remove-Item $lnkPath }
    'Kept the browser shortcut as "Phosphor-OS (Edge)".'
  }
}
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $Exe
$lnk.Arguments = '"' + (Join-Path $Project 'shell\main.mjs') + '"'
$lnk.WorkingDirectory = $Project
$lnk.IconLocation = (Join-Path $Project 'assets\phosphor-os.ico') + ',0'
$lnk.Description = 'Phosphor-OS'
$lnk.Save()
"Shortcut: $lnkPath"
