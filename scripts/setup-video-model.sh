#!/usr/bin/env bash
# A local video generator for Phosphor-OS, on the same engine as the image model (stable-diffusion.cpp's server):
#   - Wan 2.2 TI2V 5B (Alibaba): a short clip from words, or from an attached photo (the photo is the first frame).
#   - Wan 2.1 VACE 1.3B: changes an attached clip; the clip's outlines guide the new one ("make it night").
# One picker entry; a message in a tab set to it is the clip's description (see docs/VIDEO-MODEL.md).
# Files (about 16 GB): Wan 2.2 5B Q8_0 (5.4 GB) + its VAE (1.4 GB), VACE 1.3B Q8_0 (2.4 GB) + the Wan 2.1 VAE (0.3 GB),
# and the shared text encoder umT5-XXL Q8_0 (6 GB).
# Needs the image model set up first (scripts/setup-image-model.sh): it builds the engine this script uses.
#
# Run:  bash scripts/setup-video-model.sh [--dry-run] [--undo]
#   --dry-run  print every step it would take, change nothing
#   --undo     remove the services and the .env lines (model files stay; it prints how to delete them)
#
# Settings (environment variables):
#   PHOSPHOR_MODELS_DIR  where model files go (default ~/models; this script uses its video/ folder)
#   SD_DIR               the engine's folder (default ~/stable-diffusion.cpp)
#   VIDEO_PORT           (default 8085; the edit engine uses the next port)   VIDEO_MEMORY_MAX  RAM cap (default 28G)
# The servers listen on 127.0.0.1 only and have no key: the app starts one for a clip and stops it when idle.
# Restart the Phosphor-OS server afterwards: systemctl --user restart phosphor-os-server

set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT/.env"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
MODELS="${PHOSPHOR_MODELS_DIR:-$HOME/models}/video"
SD_DIR="${SD_DIR:-$HOME/stable-diffusion.cpp}"
PORT="${VIDEO_PORT:-8085}"
EDIT_PORT=$((PORT + 1))
MEMORY_MAX="${VIDEO_MEMORY_MAX:-28G}"
UNIT=phosphor-video.service
EDIT_UNIT=phosphor-video-edit.service
SERVER_BIN="$SD_DIR/build/bin/sd-server"
LABEL="Wan 2.2 video (local)"

HF=https://huggingface.co
MODEL=Wan2.2-TI2V-5B-Q8_0.gguf
VAE=wan2.2_vae.safetensors
EDIT_MODEL=wan2.1-vace-1.3b-q8_0.gguf
EDIT_VAE=wan_2.1_vae.safetensors
ENCODER=umt5-xxl-encoder-Q8_0.gguf
# file  url
DOWNLOADS="$MODEL $HF/QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/main/$MODEL
$VAE $HF/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/$VAE
$ENCODER $HF/city96/umt5-xxl-encoder-gguf/resolve/main/$ENCODER
$EDIT_MODEL $HF/calcuis/wan-1.3b-gguf/resolve/main/$EDIT_MODEL
$EDIT_VAE $HF/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/$EDIT_VAE"
ENV_KEYS='PHOSPHOR_VIDEO_URL PHOSPHOR_VIDEO_LABEL PHOSPHOR_VIDEO_UNIT PHOSPHOR_VIDEO_EDIT_URL PHOSPHOR_VIDEO_EDIT_UNIT'

DRY=0
say() { printf '%s\n' "$*"; }
die() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}
run() {
  if ((DRY)); then say "  [dry-run] $*"; else "$@"; fi
}
drop_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  local k
  for k in $ENV_KEYS; do
    if ((DRY)); then say "  [dry-run] drop $k from $ENV_FILE"; else sed -i "/^$k=/d" "$ENV_FILE"; fi
  done
}

UNDO=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --undo) UNDO=1 ;;
    *) die "unknown option: $a" ;;
  esac
done

if ((UNDO)); then
  for u in "$UNIT" "$EDIT_UNIT"; do
    run systemctl --user stop "$u" 2>/dev/null || true
    run rm -f "$CONFIG_HOME/systemd/user/$u"
  done
  run systemctl --user daemon-reload
  drop_env
  say "Removed $UNIT, $EDIT_UNIT and the picker entry. Model files stay: rm -rf '$MODELS'"
  exit 0
fi

[[ -x "$SERVER_BIN" ]] || die "the engine is missing ($SERVER_BIN): run scripts/setup-image-model.sh first"
command -v ffmpeg >/dev/null || die "ffmpeg is missing (Arch: sudo pacman -S ffmpeg); the app uses it for clips"

run mkdir -p "$MODELS"
while read -r file url; do
  if [[ ! -f "$MODELS/$file" ]]; then
    run curl -fL -C - -o "$MODELS/$file.part" "$url"
    run mv "$MODELS/$file.part" "$MODELS/$file"
  fi
done <<<"$DOWNLOADS"

# unit name, port, model, vae: --offload-to-cpu keeps the weights in RAM and moves each part to the card when needed.
write_unit() {
  local text="[Unit]
Description=Phosphor-OS: local video generator (stable-diffusion.cpp, $3, port $2)

[Service]
ExecStart=$SERVER_BIN --listen-ip 127.0.0.1 --listen-port $2 --diffusion-model $MODELS/$3 --vae $MODELS/$4 --t5xxl $MODELS/$ENCODER --offload-to-cpu --flash-attn on --sampling-method euler
# A full RAM ends the engine, not the desktop.
MemoryMax=$MEMORY_MAX
TimeoutStopSec=30
Restart=no
"
  local file="$CONFIG_HOME/systemd/user/$1"
  say "Service: $file (not started at login; the app starts it for a clip and stops it when idle)"
  if ((DRY)); then
    say "$text" | sed 's/^/    /'
  else
    mkdir -p "$(dirname "$file")"
    printf '%s' "$text" >"$file"
  fi
}
write_unit "$UNIT" "$PORT" "$MODEL" "$VAE"
write_unit "$EDIT_UNIT" "$EDIT_PORT" "$EDIT_MODEL" "$EDIT_VAE"
run systemctl --user daemon-reload

drop_env
if ((DRY)); then
  say "  [dry-run] add $ENV_KEYS to $ENV_FILE"
else
  {
    echo "PHOSPHOR_VIDEO_URL=http://127.0.0.1:$PORT"
    echo "PHOSPHOR_VIDEO_LABEL=\"$LABEL\""
    echo "PHOSPHOR_VIDEO_UNIT=$UNIT"
    echo "PHOSPHOR_VIDEO_EDIT_URL=http://127.0.0.1:$EDIT_PORT"
    echo "PHOSPHOR_VIDEO_EDIT_UNIT=$EDIT_UNIT"
  } >>"$ENV_FILE"
fi
say "Done. Restart the Phosphor-OS server when idle (systemctl --user restart phosphor-os-server), then pick \"$LABEL\"."
