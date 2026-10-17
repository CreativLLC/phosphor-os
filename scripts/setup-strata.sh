#!/usr/bin/env bash
# Strata (github.com/Niko1221/Strata) for Phosphor-OS: Qwen3.8-Flash-Next, a 125B mixture-of-experts model (about 6B
# active per token), on this PC's GPU. Default: the Coder version (half the experts, kept for code and tools), the one
# Strata names for a PC with 32 GB of RAM. Strata keeps the experts it uses most on the card, the rest in RAM, and reads
# what does not fit from the SSD (its "low-RAM mode"). It shows up in the model picker as its own entry.
# It runs on its own server (port 8082), not in the llama.cpp router. The relay (server/localrelay.ts) starts its
# service when the entry is picked, has the router unload its model first, and asks Strata to unload before a router
# model runs, so the GPU only ever holds one model. Strata also runs `local-model.sh unload` itself before it loads.
#
# Run:  bash scripts/setup-strata.sh [--dry-run] [--undo]
#   --dry-run  print every step it would take, change nothing
#   --undo     remove the service and the .env lines (Strata's folder and the model files stay; it prints how to delete them)
#
# Settings (environment variables):
#   STRATA_DIR       Strata's folder: engine, Python environment, config (default ~/strata, about 1-2 GB)
#   STRATA_DATA_DIR  the model files, about 65 GB for the Coder (default ~/strata-data; a fast SSD helps)
#   STRATA_FAMILY    coder (default) or qwen (every expert; needs more RAM, see Strata's docs/MODELS.md)
#   STRATA_MODEL     the size: IQ1_M for the Coder (its only one), Q2_0, IQ2_XS, IQ3_XXS or IQ3_S for qwen
#   STRATA_PORT      (default 8082)    STRATA_CONTEXT (default 65536)    STRATA_VERSION (default v0.1.44.1)
#   STRATA_MEMORY_MAX  RAM cap for the service, so a full RAM ends Strata instead of the desktop (default 24G)
# Needs: an AMD card Strata supports (RX 7900 XT/XTX and others, see its docs/AMD_HIP.md), git, a C++ compiler and
# ROCm 7 (Arch: the llama.cpp ROCm packages bring it; without it Strata installs its own, about 10 GB).
# The first install compiles the engine (10-20 min) and downloads the model (resumable).
# Restart the Phosphor-OS server afterwards: systemctl --user restart phosphor-os-server

set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT/.env"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STRATA_DIR="${STRATA_DIR:-$HOME/strata}"
DATA_DIR="${STRATA_DATA_DIR:-$HOME/strata-data}"
FAMILY="${STRATA_FAMILY:-coder}"
case "$FAMILY" in
  coder) MODEL="${STRATA_MODEL:-IQ1_M}" NAME=strata-flash-next-coder LABEL="Qwen3.8 Flash-Next Coder (Strata, local)" ;;
  qwen) MODEL="${STRATA_MODEL:-IQ2_XS}" NAME=strata-flash-next LABEL="Qwen3.8 Flash-Next 125B (Strata, local)" ;;
  *) printf 'STOP: STRATA_FAMILY is coder or qwen, not %s\n' "$FAMILY" >&2; exit 1 ;;
esac
# NAME is what a request calls the model (Strata answers to any name), LABEL the picker text.
PORT="${STRATA_PORT:-8082}"
CONTEXT="${STRATA_CONTEXT:-65536}"
VERSION="${STRATA_VERSION:-v0.1.44.1}"
MEMORY_MAX="${STRATA_MEMORY_MAX:-24G}"
UNIT=phosphor-strata.service
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT"
ENV_KEYS='PHOSPHOR_LOCAL_MORE_MODELS PHOSPHOR_LOCAL_URLS PHOSPHOR_LOCAL_UNITS PHOSPHOR_LOCAL_CONTEXTS'

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
  run systemctl --user stop "$UNIT" 2>/dev/null || true
  run rm -f "$UNIT_FILE"
  run systemctl --user daemon-reload
  drop_env
  say "Removed the service and the .env lines. Still on disk (delete by hand if you want them gone):"
  say "  rm -rf '$STRATA_DIR' '$DATA_DIR' '$CONFIG_HOME/strata'"
  exit 0
fi

command -v git >/dev/null || die "git is missing"
command -v g++ >/dev/null || die "a C++ compiler is missing (Arch: sudo pacman -S base-devel)"
[[ -f "$ENV_FILE" ]] && grep -q '^PHOSPHOR_LOCAL_URL=' "$ENV_FILE" || die "set up the local models first: bash scripts/setup-local-model.sh"

if [[ ! -d "$STRATA_DIR/.git" ]]; then
  say "Getting Strata $VERSION into $STRATA_DIR"
  run git clone -q --depth 1 --branch "$VERSION" https://github.com/Niko1221/Strata.git "$STRATA_DIR"
fi

# Strata names its files by family and size in lower case: run-coder-iq1_m.sh, strata-iq2_xs.json (qwen has no prefix)
TAG="$([[ $FAMILY == qwen ]] || printf '%s-' "$FAMILY")${MODEL,,}"
RUN_SCRIPT="$STRATA_DIR/run-$TAG.sh"
CONF="$STRATA_DIR/strata-$TAG.json"
if [[ ! -x "$RUN_SCRIPT" ]]; then
  say "Strata's own setup: compiles the engine for this GPU and downloads $MODEL to $DATA_DIR (long; resumable)"
  run mkdir -p "$DATA_DIR"
  # In its own memory-capped scope: if the setup runs out of memory, it ends, not the desktop.
  run systemd-run --user --scope -p MemoryMax=8G -q -- "$STRATA_DIR/setup.sh" --setup --backend hip --family "$FAMILY" \
    --model "$MODEL" --context "$CONTEXT" --vision no --port "$PORT" --no-browser --data-dir "$DATA_DIR" \
    --vram-reserve-mib 3072 --no-start --yes
fi
# 3072 MiB of VRAM stays free for the desktop: on an AMD card that also drives the screen, Strata's docs report the
# compositor being killed with less (its #560 #516).

say "Strata config: unload after 15 min idle, empty the llama.cpp router before it loads, keep 6 GiB of RAM free"
if ((DRY)); then
  say "  [dry-run] set idle_unload_s=900, before_load=local-model.sh unload, STRATA_RESIDENT_HEADROOM_GIB=6 in $CONF"
else
  [[ -f "$CONF" ]] || die "$CONF is missing: Strata's setup did not finish"
  python3 -I - "$CONF" "$PROJECT/scripts/local-model.sh" <<'EOF'
import json, sys
path, script = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
cfg["idle_unload_s"] = 900
cfg["before_load"] = ["bash", script, "unload"]
cfg["before_load_ignore_failure"] = True
# Strata's setup tip for a PC with 31 GB of RAM: 6 GiB free instead of 4 kept the speed and left the desktop more.
cfg.setdefault("env", {})["STRATA_RESIDENT_HEADROOM_GIB"] = "6"
json.dump(cfg, open(path, "w"), indent=2)
EOF
fi

say "Service: $UNIT_FILE (not started at login; the relay starts it when the model is picked)"
UNIT_TEXT="[Unit]
Description=Phosphor-OS: Strata, Qwen3.8-Flash-Next on its own server (port $PORT)

[Service]
WorkingDirectory=$STRATA_DIR
ExecStart=$RUN_SCRIPT
# A full RAM ends Strata, not the desktop.
MemoryMax=$MEMORY_MAX
TimeoutStopSec=60
Restart=no
"
if ((DRY)); then
  say "$UNIT_TEXT"
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
    echo "PHOSPHOR_LOCAL_MORE_MODELS=\"$NAME=$LABEL\""
    echo "PHOSPHOR_LOCAL_URLS=$NAME=http://127.0.0.1:$PORT"
    echo "PHOSPHOR_LOCAL_UNITS=$NAME=$UNIT"
    echo "PHOSPHOR_LOCAL_CONTEXTS=$NAME=$CONTEXT"
  } >>"$ENV_FILE"
fi
say "Done. Restart the Phosphor-OS server when idle (systemctl --user restart phosphor-os-server), then pick \"$LABEL\"."
say "By hand: systemctl --user start $UNIT, then http://127.0.0.1:$PORT (first start loads for 1-3 minutes)."
