#!/usr/bin/env bash
# Load or unload the local model (frees the GPU memory at once).
# Run:  bash scripts/local-model.sh on|off|status
# It also unloads by itself after 15 minutes idle and loads again on the next message (see docs/LOCAL-MODEL.md).
set -euo pipefail
UNIT=phosphor-local-model.service
case "${1:-status}" in
  on) systemctl --user start "$UNIT" ;;
  off) systemctl --user stop "$UNIT" ;;
  status) ;;
  *) echo "usage: local-model.sh on|off|status" >&2; exit 1 ;;
esac
echo "service: $(systemctl --user is-active "$UNIT" || true)"
for f in /sys/class/drm/card*/device/mem_info_vram_used; do
  [[ -r "$f" ]] && echo "GPU memory used: $(($(cat "$f") / 1048576)) MiB"
done
