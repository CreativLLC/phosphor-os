#!/usr/bin/env bash
# Strata (github.com/Niko1221/Strata) for Phosphor-OS: Qwen3.8-Flash-Next, a 125B mixture-of-experts model (about 6B
# active per token), on this PC's GPU. Default: the Coder version (half the experts, kept for code and tools), the one
# Strata names for a PC with 32 GB of RAM. Strata keeps the experts it uses most on the card, the rest in RAM, and reads
# what does not fit from the SSD (its "low-RAM mode"). Each size installed is its own entry in the model picker.
# Each size runs on its own server and port, not in the llama.cpp router. The relay (server/localrelay.ts) starts its
# service when the entry is picked, has the router and any other Strata size unload first, and asks Strata to unload
# before a router model runs, so the GPU only ever holds one model. Strata also runs `local-model.sh unload` itself
# before it loads.
#
# Run:  bash scripts/setup-strata.sh [--dry-run] [--undo]
#   --dry-run  print every step it would take, change nothing
#   --undo     remove this size's service and picker entry (the model files stay; it prints how to delete them)
# Run it once per size, e.g. the Coder, then STRATA_FAMILY=qwen STRATA_MODEL=IQ3_XXS for a second entry.
#
# Settings (environment variables):
#   STRATA_DIR       Strata's folder: engine, Python environment, config (default ~/strata, about 1-2 GB)
#   STRATA_DATA_DIR  the model files (default ~/strata-data; a fast SSD helps): about 65 GB for the Coder, 70-80 GB
#                    for a qwen size, less when one is installed already (they share a 29 GB file)
#   STRATA_FAMILY    coder (default) or qwen (every expert; needs more RAM, see Strata's docs/MODELS.md)
#   STRATA_MODEL     the size: IQ1_M for the Coder (its only one), Q2_0, IQ2_XS (default), IQ3_XXS or IQ3_S for qwen
#   STRATA_PORT      (default 8082 for the Coder, 8083 for qwen; two qwen sizes need different ports)
#   STRATA_CONTEXT   (default 131072; the context needs 13.7 KB of RAM per token)    STRATA_VERSION (default v0.1.44.1)
#   STRATA_MEMORY_MAX  RAM cap for the service, so a full RAM ends Strata instead of the desktop
#                    (default 24G for the Coder, 40G for qwen)
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
# NAME is what a request calls the model (Strata answers to any name), LABEL the picker text (no commas: the .env
# lists split on them).
case "$FAMILY" in
  coder)
    MODEL="${STRATA_MODEL:-IQ1_M}" NAME=strata-flash-next-coder LABEL="Qwen3.8 Flash-Next Coder (local Strata)"
    PORT="${STRATA_PORT:-8082}" MEMORY_MAX="${STRATA_MEMORY_MAX:-24G}"
    ;;
  qwen)
    MODEL="${STRATA_MODEL:-IQ2_XS}"
    NAME="strata-flash-next-${MODEL,,}" LABEL="Qwen3.8 Flash-Next 125B $MODEL (local Strata)"
    PORT="${STRATA_PORT:-8083}" MEMORY_MAX="${STRATA_MEMORY_MAX:-40G}"
    ;;
  *) printf 'STOP: STRATA_FAMILY is coder or qwen, not %s\n' "$FAMILY" >&2; exit 1 ;;
esac
CONTEXT="${STRATA_CONTEXT:-131072}"
VERSION="${STRATA_VERSION:-v0.1.44.1}"
# Strata names its files by family and size in lower case: run-coder-iq1_m.sh, strata-iq3_xxs.json (qwen has no prefix);
# its model folder keeps the size's case (models/coder-IQ1_M, models/IQ3_XXS).
PREFIX="$([[ $FAMILY == qwen ]] || printf '%s-' "$FAMILY")"
TAG="$PREFIX${MODEL,,}"
RUN_SCRIPT="$STRATA_DIR/run-$TAG.sh"
CONF="$STRATA_DIR/strata-$TAG.json"
UNIT="phosphor-strata-$TAG.service"
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT"
LEGACY_UNIT_FILE="$CONFIG_HOME/systemd/user/phosphor-strata.service" # one unit for one size, before 2026-10-19

DRY=0
say() { printf '%s\n' "$*"; }
die() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}
run() {
  if ((DRY)); then say "  [dry-run] $*"; else "$@"; fi
}
# This size's entry in the four .env lists ("name=value,name=value"): set (name, label, url, unit, context) or drop.
# Other entries (another Strata size) stay.
env_entry() {
  if ((DRY)); then
    say "  [dry-run] $1 $NAME in PHOSPHOR_LOCAL_MORE_MODELS/_URLS/_UNITS/_CONTEXTS of $ENV_FILE"
    return
  fi
  python3 -I - "$ENV_FILE" "$1" "$NAME" "$LABEL" "http://127.0.0.1:$PORT" "$UNIT" "$CONTEXT" <<'EOF'
import sys
path, action, name, *values = sys.argv[1:]
keys = ["PHOSPHOR_LOCAL_MORE_MODELS", "PHOSPHOR_LOCAL_URLS", "PHOSPHOR_LOCAL_UNITS", "PHOSPHOR_LOCAL_CONTEXTS"]
out, lists = [], {}
for line in open(path).read().splitlines():
    k = line.split("=", 1)[0]
    if k in keys:
        lists[k] = [x.strip() for x in line.split("=", 1)[1].strip().strip('"').split(",") if x.strip()]
    else:
        out.append(line)
for k, v in zip(keys, values):
    # A piece without "=" is left over from a label with a comma (the lists split on commas): it goes too.
    items = [x for x in lists.get(k, []) if "=" in x and x.split("=", 1)[0].strip() != name]
    if action == "set":
        items.append(f"{name}={v}")
    if items:
        out.append(f'{k}="{",".join(items)}"')
open(path, "w").write("\n".join(out) + "\n")
EOF
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
  [[ -f "$ENV_FILE" ]] && env_entry drop
  say "Removed $UNIT and the picker entry $NAME. Its files are still on disk (delete by hand if you want them gone):"
  say "  rm -rf '$DATA_DIR/models/$PREFIX$MODEL' '$DATA_DIR/packs/$TAG' '$RUN_SCRIPT' '$CONF'"
  say "With no Strata size left: rm -rf '$STRATA_DIR' '$DATA_DIR' '$CONFIG_HOME/strata'"
  exit 0
fi

command -v git >/dev/null || die "git is missing"
command -v g++ >/dev/null || die "a C++ compiler is missing (Arch: sudo pacman -S base-devel)"
[[ -f "$ENV_FILE" ]] && grep -q '^PHOSPHOR_LOCAL_URL=' "$ENV_FILE" || die "set up the local models first: bash scripts/setup-local-model.sh"

if [[ ! -d "$STRATA_DIR/.git" ]]; then
  say "Getting Strata $VERSION into $STRATA_DIR"
  run git clone -q --depth 1 --branch "$VERSION" https://github.com/Niko1221/Strata.git "$STRATA_DIR"
fi

if [[ ! -x "$RUN_SCRIPT" ]]; then
  say "Strata's own setup: compiles the engine for this GPU (once) and downloads $FAMILY $MODEL to $DATA_DIR (long; resumable)"
  run mkdir -p "$DATA_DIR"
  # In its own memory-capped scope: if the setup runs out of memory, it ends, not the desktop.
  run systemd-run --user --scope -p MemoryMax=8G -q -- "$STRATA_DIR/setup.sh" --setup --backend hip --family "$FAMILY" \
    --model "$MODEL" --context "$CONTEXT" --vision no --port "$PORT" --no-browser --data-dir "$DATA_DIR" \
    --vram-reserve-mib 3072 --no-start --yes
fi
# 3072 MiB of VRAM stays free for the desktop: on an AMD card that also drives the screen, Strata's docs report the
# compositor being killed with less (its #560 #516).

say "Strata config: unload after 15 min idle, empty the router and other Strata sizes before it loads, keep 6 GiB of RAM free"
if ((DRY)); then
  say "  [dry-run] set idle_unload_s=900, fit_max_tokens, max-context $CONTEXT with --kv-resident 32768, before_load=local-model.sh unload --keep, STRATA_RESIDENT_HEADROOM_GIB=6 in $CONF"
else
  [[ -f "$CONF" ]] || die "$CONF is missing: Strata's setup did not finish"
  python3 -I - "$CONF" "$PROJECT/scripts/local-model.sh" "http://127.0.0.1:$PORT" "$CONTEXT" <<'EOF'
import json, sys
path, script, own, context = sys.argv[1:]
cfg = json.load(open(path))
# The context window. Past 32K Strata keeps the older part of the KV cache in RAM (about 13.7 KB per token, 1.7 GB at
# 128K) and only the last 32K in VRAM, so a longer context costs RAM, not the experts' room on the card.
args = cfg["args"]
for flag, value in (("--max-context", context), ("--kv-resident", "32768")):
    if flag in args:
        args[args.index(flag) + 1] = value
    else:
        args += [flag, value]
cfg["idle_unload_s"] = 900
cfg["before_load"] = ["bash", script, "unload", "--keep", own]
cfg["before_load_ignore_failure"] = True
# Claude Code asks for up to 32000 output tokens on every request: without this Strata refuses (400) once the prompt
# plus 32000 passes the context. With it, Strata shortens the output to the room left (its #545).
cfg["fit_max_tokens"] = True
# Strata's setup tip for a PC with 31 GB of RAM: 6 GiB free instead of 4 kept the speed and left the desktop more.
cfg.setdefault("env", {})["STRATA_RESIDENT_HEADROOM_GIB"] = "6"
json.dump(cfg, open(path, "w"), indent=2)
EOF
fi

say "Service: $UNIT_FILE (not started at login; the relay starts it when the model is picked)"
UNIT_TEXT="[Unit]
Description=Phosphor-OS: Strata, Qwen3.8-Flash-Next $FAMILY $MODEL on its own server (port $PORT)

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
# The older single unit ran this same size: this one replaces it.
if [[ -f "$LEGACY_UNIT_FILE" ]] && grep -qxF "ExecStart=$RUN_SCRIPT" "$LEGACY_UNIT_FILE"; then
  run systemctl --user stop phosphor-strata.service 2>/dev/null || true
  run rm -f "$LEGACY_UNIT_FILE"
fi
run systemctl --user daemon-reload

env_entry set
say "Done. Restart the Phosphor-OS server when idle (systemctl --user restart phosphor-os-server), then pick \"$LABEL\"."
say "By hand: systemctl --user start $UNIT, then http://127.0.0.1:$PORT (first start loads for 1-3 minutes)."
