#!/usr/bin/env bash
# Installs the DICTATE speech engine for Phosphor-OS on Linux or a Mac (local, private, free).
# The Linux and Mac twin of scripts/setup-voice.ps1: same engine, model and VAD, same pinned hashes.
#
#   Engine: sherpa-onnx 1.13.8 (k2-fsa), Node addon from npm (sherpa-onnx-node + sherpa-onnx-linux-x64 or
#           sherpa-onnx-darwin-arm64 on an Apple Silicon Mac)
#   Model:  NVIDIA Parakeet TDT 0.6B v2, int8 (English, with punctuation and capitals)
#   VAD:    Silero VAD (finds the pauses that end a phrase, for live dictation)
#   Where:  ${XDG_DATA_HOME:-~/.local/share}/PhosphorOS/voice  (outside any synced folder: about 0.7 GB)
#           or PHOSPHOR_VOICE_DIR (from the environment or the project's .env), like the server.
#
# Run:   bash scripts/setup-voice.sh [--force] [--dry-run]
#        Parts already installed are skipped. --force reinstalls everything (the running voice engine keeps
#        the old files until it stops: restart the server after). --dry-run says what it would do.
#
# Every download comes from the official source (npm registry for the k2-fsa packages, the k2-fsa/sherpa-onnx
# GitHub release for the models) and is checked against the hash pinned below before anything is unpacked.
# Downloads go to a new empty folder that is deleted afterwards. Nothing downloaded is ever run by this script.

set -euo pipefail

FORCE=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    -h | --help)
      sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --force or --dry-run)" >&2
      exit 2
      ;;
  esac
done

VERSION=1.13.8
MODEL_NAME=parakeet-tdt-0.6b-v2-int8

# Pinned downloads. npm: the registry's sha512 "integrity" value. GitHub: the release's sha256 digest.
# The addon package is the one for this OS (the name server/voice-worker.mjs loads: sherpa-onnx-<os>-<arch>).
ENGINE_SHA512='MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag=='
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    ADDON=sherpa-onnx-linux-x64
    ADDON_SHA512='6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g=='
    ;;
  Darwin/arm64)
    ADDON=sherpa-onnx-darwin-arm64
    ADDON_SHA512='FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw=='
    ;;
  *)
    echo "STOP: Only x86-64 Linux and Apple Silicon Macs are supported here. On Windows run scripts/setup-voice.ps1." >&2
    exit 1
    ;;
esac
PKG_NAMES=(sherpa-onnx-node "$ADDON")
PKG_SHA512=("$ENGINE_SHA512" "$ADDON_SHA512")
MODEL_URL='https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2'
MODEL_SHA256='157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad'
MODEL_FOLDER='sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
MODEL_FILES=(encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt)
VAD_URL='https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
VAD_SHA256='9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
VAD_FILE=silero_vad.onnx

project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# Same folder the server uses (server/osdirs.ts): PHOSPHOR_VOICE_DIR, else the XDG data folder.
# RETRO_* and RetroClaude: the names from before the rename (Retro Claude, until 2026-10-12) still count.
root="${PHOSPHOR_VOICE_DIR:-${RETRO_VOICE_DIR:-}}"
for key in PHOSPHOR_VOICE_DIR RETRO_VOICE_DIR; do
  if [[ -z $root && -f $project/.env ]]; then root="$(sed -n "s/^$key=//p" "$project/.env" | tail -n 1 | tr -d '\r')"; fi
done
if [[ -z $root ]]; then
  data_home="${XDG_DATA_HOME:-}"
  [[ $data_home == /* ]] || data_home="$HOME/.local/share"
  app="$data_home/PhosphorOS"
  if [[ ! -e $app && -d $data_home/RetroClaude ]]; then app="$data_home/RetroClaude"; fi
  root="$app/voice"
fi

nm="$root/node_modules"
models="$root/models"
model_dir="$models/$MODEL_NAME"
vad_file="$models/$VAD_FILE"
stamp="$root/install.json"

say() { printf '%s\n' "$*"; }
die() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

for tool in curl tar base64 od bzip2; do
  command -v "$tool" >/dev/null || die "Missing the tool '$tool'. Install it with pacman (Mac: Homebrew), then run this again."
done
# A Mac has shasum instead of sha256sum and sha512sum.
if command -v sha256sum >/dev/null && command -v sha512sum >/dev/null; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
  sha512_of() { sha512sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
  sha512_of() { shasum -a 512 "$1" | cut -d' ' -f1; }
else
  die "Missing sha256sum and sha512sum (or shasum). Install coreutils, then run this again."
fi

check_sha256() { # file want
  local got
  got="$(sha256_of "$1")"
  [[ $got == "$2" ]] || die "SHA-256 mismatch for $1
  want $2
  got  $got"
  say "  sha256 ok"
}

# npm's integrity is base64 of the raw SHA-512; compare it as hex.
check_sha512_integrity() { # file want-base64
  local want got
  want="$(printf '%s' "$2" | base64 -d | od -An -v -tx1 | tr -d ' \n')"
  got="$(sha512_of "$1")"
  [[ $got == "$want" ]] || die "SHA-512 mismatch for $1
  want $want
  got  $got"
  say "  sha512 ok"
}

get_file() { # url dest
  say "Downloading $1"
  curl -fsSL --retry 3 -o "$2" "$1" || die "Download failed: $1"
}

# What is already in place (skipped unless --force).
engine_ok=0
if [[ -f $nm/sherpa-onnx-node/package.json ]] &&
  grep -q "\"version\": *\"$VERSION\"" "$nm/sherpa-onnx-node/package.json" &&
  [[ -f $nm/$ADDON/sherpa-onnx.node ]]; then
  engine_ok=1
fi
model_ok=1
for f in "${MODEL_FILES[@]}"; do [[ -f $model_dir/$f ]] || model_ok=0; done
vad_ok=0
if [[ -f $vad_file ]] && [[ $(sha256_of "$vad_file") == "$VAD_SHA256" ]]; then vad_ok=1; fi
if ((FORCE)); then
  engine_ok=0
  model_ok=0
  vad_ok=0
fi

say "Voice engine folder: $root"
if ((engine_ok && model_ok && vad_ok)) && [[ -f $stamp ]]; then
  say "Voice engine, model and VAD already installed."
  exit 0
fi

if ((DRY)); then
  ((engine_ok)) && say "  Engine sherpa-onnx $VERSION already installed." || say "  [dry-run] download ${PKG_NAMES[*]} $VERSION from registry.npmjs.org, check sha512, unpack into $nm"
  ((model_ok)) && say "  Model $MODEL_NAME already installed." || say "  [dry-run] download $MODEL_URL (about 0.6 GB), check sha256, keep ${MODEL_FILES[*]} in $model_dir"
  ((vad_ok)) && say "  Silero VAD already installed." || say "  [dry-run] download $VAD_URL, check sha256, put it at $vad_file"
  say "  [dry-run] write $stamp"
  exit 0
fi

mkdir -p "$root" "$models"
dl="$(mktemp -d "$root/_download-XXXXXXXX")"
trap 'rm -rf "$dl"' EXIT

# 1. Engine: two npm packages, unpacked as node_modules so `require('sherpa-onnx-node')` finds its addon.
if ((engine_ok)); then
  say "Engine sherpa-onnx $VERSION already installed."
else
  for i in "${!PKG_NAMES[@]}"; do
    name="${PKG_NAMES[$i]}"
    file="$dl/$name.tgz"
    get_file "https://registry.npmjs.org/$name/-/$name-$VERSION.tgz" "$file"
    check_sha512_integrity "$file" "${PKG_SHA512[$i]}"
    x="$dl/x-$name"
    mkdir "$x"
    tar -xzf "$file" -C "$x" || die "Unpack failed: $file"
    [[ -d $x/package ]] || die "Unexpected package layout in $file"
    mkdir -p "$nm"
    rm -rf "${nm:?}/$name"
    mv "$x/package" "$nm/$name"
  done
fi

# 2. Speech model: keep only the four files the recognizer needs (drop the sample wavs).
if ((model_ok)); then
  say "Model $MODEL_NAME already installed."
else
  file="$dl/model.tar.bz2"
  get_file "$MODEL_URL" "$file"
  check_sha256 "$file" "$MODEL_SHA256"
  x="$dl/x-model"
  mkdir "$x"
  tar -xjf "$file" -C "$x" || die "Unpack failed: $file"
  rm -rf "$model_dir"
  mkdir -p "$model_dir"
  for f in "${MODEL_FILES[@]}"; do mv "$x/$MODEL_FOLDER/$f" "$model_dir/$f"; done
fi

# 3. Silero VAD: a single small file.
if ((vad_ok)); then
  say "Silero VAD already installed."
else
  file="$dl/$VAD_FILE"
  get_file "$VAD_URL" "$file"
  check_sha256 "$file" "$VAD_SHA256"
  mv -f "$file" "$vad_file"
fi

# 4. Record what is installed. The app server reads this to find the models.
cat >"$stamp" <<EOF
{
  "engine": "sherpa-onnx-node",
  "engineVersion": "$VERSION",
  "model": "$MODEL_NAME",
  "modelDir": "models/$MODEL_NAME",
  "vad": "models/$VAD_FILE",
  "installed": "$(date +%Y-%m-%dT%H:%M:%S)"
}
EOF

say "Done. Installed in $root"
