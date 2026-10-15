# Installs the DICTATE speech engine for Phosphor-OS (local, private, free).
#
#   Engine: sherpa-onnx 1.13.8 (k2-fsa), Node addon from npm
#   Model:  NVIDIA Parakeet TDT 0.6B v2, int8 (English, with punctuation and capitals)
#   VAD:    Silero VAD (finds the pauses that end a phrase, for live dictation)
#   Where:  %LOCALAPPDATA%\PhosphorOS\voice   (outside any synced folder: about 0.7 GB)
#
# Run:   powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1
#        Parts already installed are skipped. Add -Force to reinstall everything
#        (close Phosphor-OS first: the running voice engine keeps its files open).
#
# Every download comes from the official source (npm registry for the k2-fsa packages, the
# k2-fsa/sherpa-onnx GitHub release for the models) and is checked against the hash pinned below
# before anything is unpacked. Downloads go to a new empty folder that is deleted afterwards.
# Nothing downloaded is ever run by this script.

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Installed under the old name (Retro Claude)? Its RetroClaude folder is used while it is the only one.
$App = Join-Path $env:LOCALAPPDATA 'PhosphorOS'
$OldApp = Join-Path $env:LOCALAPPDATA 'RetroClaude'
if (-not (Test-Path -LiteralPath $App) -and (Test-Path -LiteralPath $OldApp)) { $App = $OldApp }
$Root = Join-Path $App 'voice'
$ModelName = 'parakeet-tdt-0.6b-v2-int8'
$Version = '1.13.8'

# Pinned downloads. npm: the registry's sha512 "integrity" value. GitHub: the release's sha256 digest.
$Packages = @(
  @{ Name = 'sherpa-onnx-node'; Url = "https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-$Version.tgz"
     Sha512 = 'MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==' },
  @{ Name = 'sherpa-onnx-win-x64'; Url = "https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-$Version.tgz"
     Sha512 = 'oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==' }
)
$Model = @{
  Url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2'
  Sha256 = '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad'
  Folder = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
  Files = @('encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt')
}
$Vad = @{
  Url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
  Sha256 = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
  File = 'silero_vad.onnx'
}

$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'   # Windows' own bsdtar (reads .tgz and .tar.bz2)
$Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$Stamp = Join-Path $Root 'install.json'
$nm = Join-Path $Root 'node_modules'
$models = Join-Path $Root 'models'
$modelDir = Join-Path $models $ModelName
$vadFile = Join-Path $models $Vad.File

function Get-File([string]$Url, [string]$Dest) {
  Write-Host "Downloading $Url"
  & $Curl -fsSL --retry 3 -o $Dest $Url
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
}

function Test-Sha256([string]$File, [string]$Want) {
  return (Get-FileHash -Algorithm SHA256 $File).Hash.ToLower() -eq $Want.ToLower()
}

function Assert-Sha256([string]$File, [string]$Want) {
  if (-not (Test-Sha256 $File $Want)) {
    throw "SHA-256 mismatch for $File`n  want $Want`n  got  $((Get-FileHash -Algorithm SHA256 $File).Hash.ToLower())"
  }
  Write-Host "  sha256 ok"
}

function Assert-Sha512Integrity([string]$File, [string]$Want) {
  $hex = (Get-FileHash -Algorithm SHA512 $File).Hash
  $bytes = [byte[]]::new($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  $got = [Convert]::ToBase64String($bytes)
  if ($got -ne $Want) { throw "SHA-512 mismatch for $File`n  want $Want`n  got  $got" }
  Write-Host "  sha512 ok"
}

# What is already in place (skipped unless -Force).
$engineOk = $false
$pkg = Join-Path $nm 'sherpa-onnx-node\package.json'
if (Test-Path $pkg) { $engineOk = (Get-Content $pkg -Raw | ConvertFrom-Json).version -eq $Version }
$engineOk = $engineOk -and (Test-Path (Join-Path $nm 'sherpa-onnx-win-x64\sherpa-onnx.node'))
$modelOk = @($Model.Files | Where-Object { -not (Test-Path (Join-Path $modelDir $_)) }).Count -eq 0
$vadOk = (Test-Path $vadFile) -and (Test-Sha256 $vadFile $Vad.Sha256)
if ($Force) { $engineOk = $false; $modelOk = $false; $vadOk = $false }

New-Item -ItemType Directory -Force $Root, $models | Out-Null
$dl = Join-Path $Root ('_download-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $dl | Out-Null

try {
  # 1. Engine: two npm packages, unpacked as node_modules so `require('sherpa-onnx-node')` finds its addon.
  if ($engineOk) { Write-Host "Engine sherpa-onnx $Version already installed." }
  else {
    foreach ($p in $Packages) {
      $file = Join-Path $dl "$($p.Name).tgz"
      Get-File $p.Url $file
      Assert-Sha512Integrity $file $p.Sha512
      $x = Join-Path $dl "x-$($p.Name)"
      New-Item -ItemType Directory $x | Out-Null
      & $Tar -xzf $file -C $x
      if ($LASTEXITCODE -ne 0) { throw "Unpack failed: $file" }
      $target = Join-Path $nm $p.Name
      if (Test-Path $target) { Remove-Item -Recurse -Force $target }
      New-Item -ItemType Directory -Force $nm | Out-Null
      Move-Item (Join-Path $x 'package') $target
    }
  }

  # 2. Speech model: keep only the four files the recognizer needs (drop the sample wavs).
  if ($modelOk) { Write-Host "Model $ModelName already installed." }
  else {
    $file = Join-Path $dl 'model.tar.bz2'
    Get-File $Model.Url $file
    Assert-Sha256 $file $Model.Sha256
    $x = Join-Path $dl 'x-model'
    New-Item -ItemType Directory $x | Out-Null
    & $Tar -xjf $file -C $x
    if ($LASTEXITCODE -ne 0) { throw "Unpack failed: $file" }
    if (Test-Path $modelDir) { Remove-Item -Recurse -Force $modelDir }
    New-Item -ItemType Directory -Force $modelDir | Out-Null
    foreach ($f in $Model.Files) { Move-Item (Join-Path $x "$($Model.Folder)\$f") (Join-Path $modelDir $f) }
  }

  # 3. Silero VAD: a single small file.
  if ($vadOk) { Write-Host "Silero VAD already installed." }
  else {
    $file = Join-Path $dl $Vad.File
    Get-File $Vad.Url $file
    Assert-Sha256 $file $Vad.Sha256
    Move-Item -Force $file $vadFile
  }

  # 4. Record what is installed. The app server reads this to find the models.
  [ordered]@{
    engine = 'sherpa-onnx-node'
    engineVersion = $Version
    model = $ModelName
    modelDir = "models/$ModelName"
    vad = "models/$($Vad.File)"
    installed = (Get-Date).ToString('s')
  } | ConvertTo-Json | Set-Content -Encoding ascii $Stamp

  Write-Host "Done. Installed in $Root"
} finally {
  Remove-Item -Recurse -Force $dl -ErrorAction SilentlyContinue
}
