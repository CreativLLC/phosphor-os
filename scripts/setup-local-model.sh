#!/usr/bin/env bash
# Local models for Phosphor-OS, through llama.cpp on this PC's GPU. They show up in the model picker:
#   Qwen3.8-27B (Unsloth IQ3_S, about 12 GB) with MTP drafting (a small extra model guesses ahead; answers stay the
#   same, only faster), Qwen3.6-35B-A3B (Unsloth IQ3_S, about 13 GB, a mixture-of-experts model), Gemma 4 26B-A4B
#   (Unsloth UD-IQ4_XS, about 14 GB, mixture-of-experts) and Gemma 4 E4B (Unsloth Q4_K_M, about 5 GB, small and fast).
# One llama-server runs in router mode: the "model" in each request picks the model, and only one stays in GPU memory
# (--models-max 1), so choosing the other one swaps them (about 30 s). Each model has its own section in the preset
# file (~/.config/phosphor-os/local-models.ini), so per-model settings (like the MTP draft) stay.
# Each model also gets its vision file (mmproj, about 1 GB, F16): without it a model fails on any image (a
# screenshot Claude reads, a picture you attach) with "image input is not supported".
# Needs a GPU with about 18 GB free, through ROCm (Arch/Omarchy). Another GPU or size: change device and ctx-size
# in the preset text below.
#
# Run:  bash scripts/setup-local-model.sh [--dry-run] [--undo]
#   --dry-run  print every step it would take, change nothing
#   --undo     stop and remove the service, the preset, the key and the .env lines (the model files stay)
#
# Needs llama.cpp with the ROCm backend first:  sudo pacman -S llama-cpp ggml-hip
# The server listens on 127.0.0.1 only and wants a key (a random one, saved in .env and ~/.config/phosphor-os).
# It frees the GPU after 15 minutes idle and loads again (about 30 s) on the next message.
# Restart the Phosphor-OS server afterwards: systemctl --user restart phosphor-os-server

set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT/.env"
MODELS="${PHOSPHOR_MODELS_DIR:-$HOME/models}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
UNIT=phosphor-local-model.service
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT"
KEY_FILE="$CONFIG_HOME/phosphor-os/local-model.key"
TEMPLATE="$CONFIG_HOME/phosphor-os/qwen3.8-chat-template.jinja"
PRESET="$CONFIG_HOME/phosphor-os/local-models.ini"
HF=https://huggingface.co/unsloth
MAIN=Qwen3.8-27B-UD-IQ3_S.gguf
DRAFT=mtp-Qwen3.8-27B-Q4_0.gguf
MOE=Qwen3.6-35B-A3B-UD-IQ3_S.gguf
GEMMA=gemma-4-26B-A4B-it-UD-IQ4_XS.gguf
GEMMA_SMALL=gemma-4-E4B-it-Q4_K_M.gguf
# Vision files: each repo names its own mmproj-F16.gguf, so they are saved under the model's name.
MAIN_VISION=mmproj-Qwen3.8-27B-F16.gguf
MOE_VISION=mmproj-Qwen3.6-35B-A3B-F16.gguf
GEMMA_VISION=mmproj-gemma-4-26B-A4B-it-F16.gguf
GEMMA_SMALL_VISION=mmproj-gemma-4-E4B-it-F16.gguf
PORT=8081
CONTEXT=98304
# The picker entries, "name=label" (the first one is the picker value "local"); the name is what a request calls the model.
MODEL_LIST="qwen3.8-27b=Qwen3.8 27B (local),qwen3.6-35b=Qwen3.6 35B MoE (local),gemma4-26b=Gemma 4 26B MoE (local),gemma4-e4b=Gemma 4 E4B (local)"
ENV_KEYS='PHOSPHOR_LOCAL_URL PHOSPHOR_LOCAL_MODELS PHOSPHOR_LOCAL_MODEL PHOSPHOR_LOCAL_LABEL PHOSPHOR_LOCAL_KEY PHOSPHOR_LOCAL_CONTEXT'

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

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --undo) UNDO=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done

if [[ "${UNDO:-0}" == 1 ]]; then
  run systemctl --user disable --now "$UNIT" || true
  run rm -f "$UNIT_FILE" "$KEY_FILE" "$TEMPLATE" "$PRESET"
  run systemctl --user daemon-reload
  drop_env
  say "Removed. Model files are still in $MODELS."
  exit 0
fi

if ! command -v llama-server >/dev/null; then
  ((DRY)) && say "  [dry-run] llama-server is missing (run: sudo pacman -S llama-cpp ggml-hip)" || die "llama-server is missing. Run: sudo pacman -S llama-cpp ggml-hip"
elif ! llama-server --list-devices 2>&1 | grep -q '^ *ROCm0'; then
  ((DRY)) && say "  [dry-run] llama.cpp sees no ROCm GPU" || die "llama.cpp sees no ROCm GPU (ggml-hip installed? run: llama-server --list-devices)"
elif ! llama-server --help 2>&1 | grep -q -e '--models-preset'; then
  die "this llama.cpp has no router mode (--models-preset). Update it: sudo pacman -Syu llama-cpp ggml-hip"
fi

run mkdir -p "$MODELS"
[[ -f "$MODELS/$MAIN" ]] || run curl -fL -C - -o "$MODELS/$MAIN" "$HF/Qwen3.8-27B-GGUF/resolve/main/$MAIN"
[[ -f "$MODELS/$DRAFT" ]] || run curl -fL -C - -o "$MODELS/$DRAFT" "$HF/Qwen3.8-27B-GGUF/resolve/main/MTP/$DRAFT"
[[ -f "$MODELS/$MOE" ]] || run curl -fL -C - -o "$MODELS/$MOE" "$HF/Qwen3.6-35B-A3B-GGUF/resolve/main/$MOE"
[[ -f "$MODELS/$GEMMA" ]] || run curl -fL -C - -o "$MODELS/$GEMMA" "$HF/gemma-4-26B-A4B-it-GGUF/resolve/main/$GEMMA"
[[ -f "$MODELS/$GEMMA_SMALL" ]] || run curl -fL -C - -o "$MODELS/$GEMMA_SMALL" "$HF/gemma-4-E4B-it-GGUF/resolve/main/$GEMMA_SMALL"
[[ -f "$MODELS/$MAIN_VISION" ]] || run curl -fL -C - -o "$MODELS/$MAIN_VISION" "$HF/Qwen3.8-27B-GGUF/resolve/main/mmproj-F16.gguf"
[[ -f "$MODELS/$MOE_VISION" ]] || run curl -fL -C - -o "$MODELS/$MOE_VISION" "$HF/Qwen3.6-35B-A3B-GGUF/resolve/main/mmproj-F16.gguf"
[[ -f "$MODELS/$GEMMA_VISION" ]] || run curl -fL -C - -o "$MODELS/$GEMMA_VISION" "$HF/gemma-4-26B-A4B-it-GGUF/resolve/main/mmproj-F16.gguf"
[[ -f "$MODELS/$GEMMA_SMALL_VISION" ]] || run curl -fL -C - -o "$MODELS/$GEMMA_SMALL_VISION" "$HF/gemma-4-E4B-it-GGUF/resolve/main/mmproj-F16.gguf"

if [[ ! -f "$KEY_FILE" ]]; then
  run mkdir -p "$(dirname "$KEY_FILE")"
  if ((DRY)); then say "  [dry-run] write a random key to $KEY_FILE"; else (umask 077 && head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$KEY_FILE"); fi
fi

run cp "$PROJECT/os/local-model/qwen3.8-chat-template.jinja" "$TEMPLATE"

# Preset file: [*] is shared; each [name] section is one model. Keys are llama-server options without the dashes.
# The Qwen chat template is Qwen's only: Gemma uses the template inside its own model file.
PRESET_TEXT="version = 1

[*]
device = ROCm0
n-gpu-layers = 999
ctx-size = $CONTEXT
flash-attn = on
cache-type-k = q8_0
cache-type-v = q8_0
batch-size = 2048
ubatch-size = 512
parallel = 1
jinja = on
sleep-idle-seconds = 900

[qwen3.8-27b]
model = $MODELS/$MAIN
mmproj = $MODELS/$MAIN_VISION
chat-template-file = $TEMPLATE
model-draft = $MODELS/$DRAFT
spec-type = draft-mtp
spec-draft-n-max = 3

[qwen3.6-35b]
model = $MODELS/$MOE
mmproj = $MODELS/$MOE_VISION
chat-template-file = $TEMPLATE
chat-template-kwargs = {\"reasoning_effort\":\"low\"}

[gemma4-26b]
model = $MODELS/$GEMMA
mmproj = $MODELS/$GEMMA_VISION

[gemma4-e4b]
model = $MODELS/$GEMMA_SMALL
mmproj = $MODELS/$GEMMA_SMALL_VISION
"

UNIT_TEXT="[Unit]
Description=Phosphor-OS local models (llama.cpp)

[Service]
ExecStart=$(command -v llama-server || echo llama-server) --models-preset $PRESET --models-max 1 --host 127.0.0.1 --port $PORT --api-key-file $KEY_FILE
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
"

if ((DRY)); then
  say "  [dry-run] write $PRESET:"
  say "$PRESET_TEXT" | sed 's/^/    /'
  say "  [dry-run] write $UNIT_FILE:"
  say "$UNIT_TEXT" | sed 's/^/    /'
else
  mkdir -p "$(dirname "$UNIT_FILE")"
  printf '%s\n' "$PRESET_TEXT" >"$PRESET"
  printf '%s' "$UNIT_TEXT" >"$UNIT_FILE"
fi

drop_env
if ((DRY)); then
  say "  [dry-run] add PHOSPHOR_LOCAL_URL, PHOSPHOR_LOCAL_MODELS, PHOSPHOR_LOCAL_KEY, PHOSPHOR_LOCAL_CONTEXT to $ENV_FILE"
else
  {
    echo "PHOSPHOR_LOCAL_URL=http://127.0.0.1:$PORT"
    echo "PHOSPHOR_LOCAL_MODELS=\"$MODEL_LIST\""
    echo "PHOSPHOR_LOCAL_KEY=$(cat "$KEY_FILE")"
    echo "PHOSPHOR_LOCAL_CONTEXT=$CONTEXT"
  } >>"$ENV_FILE"
fi

run systemctl --user daemon-reload
run systemctl --user enable "$UNIT"
run systemctl --user restart "$UNIT"
say "Done. Check: systemctl --user status $UNIT   (a model loads on the first message, about 30 s)"
