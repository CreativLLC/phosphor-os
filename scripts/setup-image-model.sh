#!/usr/bin/env bash
# A local image generator for Phosphor-OS: Qwen-Image 2.1 (Alibaba, 7B, text to image and editing a given picture)
# on this PC's GPU, through stable-diffusion.cpp's server. It shows up in the model picker; a message in a tab set
# to it is the picture's description (see docs/IMAGE-MODEL.md).
# Files (about 19 GB): the model at Q8_0 (7.7 GB), its text encoder Qwen3-VL 8B at Q8_0 (8.7 GB) and that encoder's
# vision part (1.2 GB, for editing), the VAE (0.7 GB) and the Turbo LoRA (0.9 GB, the default 8-step mode).
# The engine is compiled here for the GPU (ROCm/HIP, AMD; 10-20 minutes the first time).
#
# Run:  bash scripts/setup-image-model.sh [--dry-run] [--undo]
#   --dry-run  print every step it would take, change nothing
#   --undo     remove the service and the .env lines (engine and model files stay; it prints how to delete them)
#
# Settings (environment variables):
#   PHOSPHOR_MODELS_DIR  where model files go (default ~/models; this script uses its image/ folder)
#   SD_DIR               the engine's folder (default ~/stable-diffusion.cpp)
#   SD_VERSION           the engine's commit (default: the one this script was tested with)
#   IMAGE_PORT           (default 8084)          IMAGE_MEMORY_MAX  RAM cap for the service (default 28G)
#   GPU_TARGET           the card's architecture (default: from rocminfo, e.g. gfx1100)
# Needs: git, cmake, ROCm with hipcc and hipBLAS (Arch: sudo pacman -S rocm-hip-sdk; the llama.cpp ROCm packages
# bring most of it), and an AMD card with about 16 GB of VRAM free. Another GPU: build with -DSD_VULKAN=ON or
# -DSD_CUDA=ON instead (edit the cmake line below).
# The server listens on 127.0.0.1 only. It has no key of its own (stable-diffusion.cpp has none): the app starts
# it on demand and stops it after IMAGE idle time, so it is off most of the time.
# Restart the Phosphor-OS server afterwards: systemctl --user restart phosphor-os-server

set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT/.env"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
MODELS="${PHOSPHOR_MODELS_DIR:-$HOME/models}/image"
SD_DIR="${SD_DIR:-$HOME/stable-diffusion.cpp}"
SD_VERSION="${SD_VERSION:-b13a48219d5cdf408edcb93da6cd69b612ed03d3}"
PORT="${IMAGE_PORT:-8084}"
MEMORY_MAX="${IMAGE_MEMORY_MAX:-28G}"
UNIT=phosphor-image.service
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT"
SERVER_BIN="$SD_DIR/build/bin/sd-server"
LABEL="Qwen-Image 2.1 (local)"

HF=https://huggingface.co
MODEL=qwen_image_2.1-Q8_0.gguf
ENCODER=Qwen3VL-8B-Instruct-Q8_0.gguf
VISION=mmproj-Qwen3VL-8B-Instruct-F16.gguf
VAE=qwen_image_2.1_vae_bf16.safetensors
TURBO=qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors
# file  url
DOWNLOADS="$MODEL $HF/leejet/Qwen-Image-2.1-GGUF/resolve/main/$MODEL
$ENCODER $HF/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/$ENCODER
$VISION $HF/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/$VISION
$VAE $HF/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/$VAE
$TURBO $HF/Comfy-Org/Qwen-Image-2.1/resolve/main/loras/$TURBO"
ENV_KEYS='PHOSPHOR_IMAGE_URL PHOSPHOR_IMAGE_LABEL PHOSPHOR_IMAGE_UNIT PHOSPHOR_IMAGE_EDIT PHOSPHOR_IMAGE_TURBO'

DRY=0
say() { printf '%s\n' "$*"; }
die() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}
# Every change goes through run: in a dry run it is printed instead.
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
  run systemctl --user stop "$UNIT" 2>/dev/null || true
  run rm -f "$UNIT_FILE"
  run systemctl --user daemon-reload
  drop_env
  say "Removed $UNIT and the picker entry. Still on disk (delete by hand if you want them gone):"
  say "  rm -rf '$SD_DIR' '$MODELS'"
  say "Pictures you made stay in the app's data/images folder."
  exit 0
fi

command -v git >/dev/null || die "git is missing"
command -v cmake >/dev/null || die "cmake is missing (Arch: sudo pacman -S cmake)"
ROCM="${ROCM_PATH:-/opt/rocm}"
[[ -x "$ROCM/bin/hipcc" ]] || die "ROCm's hipcc is missing in $ROCM/bin (Arch: sudo pacman -S rocm-hip-sdk)"
GPU="${GPU_TARGET:-$("$ROCM/bin/rocminfo" 2>/dev/null | awk '/ *Name: +gfx[1-9]/ {print $2; exit}' || true)}"
[[ -n "$GPU" ]] || die "no AMD GPU found by rocminfo (set GPU_TARGET, e.g. gfx1100)"

# The engine, pinned to one commit (its tags move daily).
if [[ "$(git -C "$SD_DIR" rev-parse HEAD 2>/dev/null || true)" != "$SD_VERSION" ]]; then
  say "Getting stable-diffusion.cpp $SD_VERSION into $SD_DIR"
  run mkdir -p "$SD_DIR"
  [[ -d "$SD_DIR/.git" ]] || run git -C "$SD_DIR" init -q
  git -C "$SD_DIR" remote get-url origin >/dev/null 2>&1 || run git -C "$SD_DIR" remote add origin https://github.com/leejet/stable-diffusion.cpp.git
  run git -C "$SD_DIR" fetch -q --depth 1 origin "$SD_VERSION"
  run git -C "$SD_DIR" checkout -q FETCH_HEAD
  run git -C "$SD_DIR" submodule update -q --init --depth 1 ggml thirdparty/libwebp thirdparty/libwebm
  run rm -f "$SERVER_BIN"
fi

if [[ ! -x "$SERVER_BIN" ]]; then
  say "Compiling the engine for $GPU (10-20 minutes, in a memory-capped scope)"
  # In its own memory-capped scope: if the compiler runs out of memory, it ends, not the desktop.
  run env PATH="$ROCM/bin:$PATH" HIP_PATH="$ROCM" ROCM_PATH="$ROCM" systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- \
    cmake -S "$SD_DIR" -B "$SD_DIR/build" -DCMAKE_C_COMPILER="$ROCM/llvm/bin/clang" -DCMAKE_CXX_COMPILER="$ROCM/llvm/bin/clang++" \
    -DSD_HIPBLAS=ON -DCMAKE_BUILD_TYPE=Release -DGPU_TARGETS="$GPU" -DAMDGPU_TARGETS="$GPU" \
    -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  run env PATH="$ROCM/bin:$PATH" systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- \
    cmake --build "$SD_DIR/build" --config Release -j 8 --target sd-server
fi

run mkdir -p "$MODELS"
# Downloads resume (-C -); a file gets its name only once it is complete.
while read -r file url; do
  if [[ ! -f "$MODELS/$file" ]]; then
    run curl -fL -C - -o "$MODELS/$file.part" "$url"
    run mv "$MODELS/$file.part" "$MODELS/$file"
  fi
done <<<"$DOWNLOADS"

# --offload-to-cpu: the weights wait in RAM and move to the card part by part (encoder, then the model, then the
# VAE), so all of it fits a 20 GB card with the desktop running. Flash attention on the model saves VRAM at 2K.
UNIT_TEXT="[Unit]
Description=Phosphor-OS: local image generator (stable-diffusion.cpp, Qwen-Image 2.1, port $PORT)

[Service]
ExecStart=$SERVER_BIN --listen-ip 127.0.0.1 --listen-port $PORT --diffusion-model $MODELS/$MODEL --llm $MODELS/$ENCODER --llm_vision $MODELS/$VISION --vae $MODELS/$VAE --lora-model-dir $MODELS --offload-to-cpu --flash-attn on --sampling-method euler
# A full RAM ends the engine, not the desktop.
MemoryMax=$MEMORY_MAX
TimeoutStopSec=30
Restart=no
"
say "Service: $UNIT_FILE (not started at login; the app starts it for a picture and stops it when idle)"
if ((DRY)); then
  say "$UNIT_TEXT" | sed 's/^/    /'
else
  mkdir -p "$(dirname "$UNIT_FILE")"
  printf '%s' "$UNIT_TEXT" >"$UNIT_FILE"
fi
run systemctl --user daemon-reload

drop_env
if ((DRY)); then
  say "  [dry-run] add $ENV_KEYS to $ENV_FILE"
else
  {
    echo "PHOSPHOR_IMAGE_URL=http://127.0.0.1:$PORT"
    echo "PHOSPHOR_IMAGE_LABEL=\"$LABEL\""
    echo "PHOSPHOR_IMAGE_UNIT=$UNIT"
    echo "PHOSPHOR_IMAGE_EDIT=1"
    echo "PHOSPHOR_IMAGE_TURBO=$TURBO"
  } >>"$ENV_FILE"
fi
say "Done. Restart the Phosphor-OS server when idle (systemctl --user restart phosphor-os-server), then pick \"$LABEL\"."
say "By hand: systemctl --user start $UNIT, then http://127.0.0.1:$PORT (a small web page of its own)."
