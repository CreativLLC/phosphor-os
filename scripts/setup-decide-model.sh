#!/usr/bin/env bash
# Decision model for Phosphor-OS: a small "system one" model that answers typed questions (yes/no, pick one) in about
# a second, on the CPU, through llama.cpp's /v1/systemone. AUTO asks it which model and thinking level a message
# needs before it asks Haiku (docs/LOCAL-MODEL.md "Decision model"); other parts call it through server/decide.ts.
#   Kev-0.8B (ggml-org GGUF, Q8_0, 0.8 GB file, Apache-2.0). About 2 GB of RAM while awake, 0.2 GB asleep.
# CPU only on purpose: the GPU stays free for the big models. The unit hides every GPU from it.
#
# Run:  bash scripts/setup-decide-model.sh [--dry-run] [--undo]
#   --dry-run  print every step it would take, change nothing
#   --undo     stop and remove the service and the .env line (the model file stays)
#
# Needs llama.cpp with /v1/systemone (0.6.0 or newer):  sudo pacman -S llama-cpp
# Settings (environment): DECIDE_PORT (8090), DECIDE_THREADS (12 CPU threads while it answers).
# It sleeps after 15 minutes idle (RAM back) and wakes on the next question (under a second).
# Restart the Phosphor-OS server afterwards: systemctl --user restart phosphor-os-server

set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT/.env"
MODELS="${PHOSPHOR_MODELS_DIR:-$HOME/models}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
UNIT=phosphor-decide.service
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT"
MODEL=Kev-0.8B-Q8_0.gguf
URL=https://huggingface.co/ggml-org/Kev-0.8B-GGUF/resolve/main/$MODEL
PORT="${DECIDE_PORT:-8090}"
THREADS="${DECIDE_THREADS:-12}"
ENV_KEYS='PHOSPHOR_DECIDE_URL'

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
  run rm -f "$UNIT_FILE"
  run systemctl --user daemon-reload
  drop_env
  say "Removed. The model file is still in $MODELS ($MODEL)."
  exit 0
fi

if ! command -v llama-server >/dev/null; then
  ((DRY)) && say "  [dry-run] llama-server is missing (run: sudo pacman -S llama-cpp)" || die "llama-server is missing. Run: sudo pacman -S llama-cpp"
elif (($(llama-server --version 2>&1 | grep -oP 'build \K[0-9]+' || echo 0) < 11361)); then
  ((DRY)) && say "  [dry-run] this llama.cpp has no /v1/systemone" || die "this llama.cpp is too old for decision models (/v1/systemone, build 11361). Update it: sudo pacman -Syu llama-cpp"
fi

run mkdir -p "$MODELS"
[[ -f "$MODELS/$MODEL" ]] || run curl -fL -C - -o "$MODELS/$MODEL" "$URL"

# 16 slots: up to 16 questions of one call run side by side, sharing the state's reading; 2048 tokens each.
# The GPU variables hide every GPU (ROCm, Vulkan), so nothing lands in VRAM even if llama.cpp would offload.
UNIT_TEXT="[Unit]
Description=Phosphor-OS decision model (llama.cpp, CPU)

[Service]
Environment=HIP_VISIBLE_DEVICES=-1 ROCR_VISIBLE_DEVICES=-1 GGML_VK_VISIBLE_DEVICES=-1
ExecStart=$(command -v llama-server || echo llama-server) -m $MODELS/$MODEL --alias kev-0.8b --device none -ngl 0 --threads $THREADS --parallel 16 --ctx-size 32768 --batch-size 2048 --ubatch-size 2048 --sleep-idle-seconds 900 --no-webui --host 127.0.0.1 --port $PORT
MemoryMax=3G
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
"

if ((DRY)); then
  say "  [dry-run] write $UNIT_FILE:"
  say "$UNIT_TEXT" | sed 's/^/    /'
else
  mkdir -p "$(dirname "$UNIT_FILE")"
  printf '%s' "$UNIT_TEXT" >"$UNIT_FILE"
fi

drop_env
if ((DRY)); then
  say "  [dry-run] add PHOSPHOR_DECIDE_URL=http://127.0.0.1:$PORT to $ENV_FILE"
else
  echo "PHOSPHOR_DECIDE_URL=http://127.0.0.1:$PORT" >>"$ENV_FILE"
fi

run systemctl --user daemon-reload
run systemctl --user enable "$UNIT"
run systemctl --user restart "$UNIT"
say "Done. Check: curl -s http://127.0.0.1:$PORT/health   (then restart the Phosphor-OS server when idle)"
