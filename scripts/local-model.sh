#!/usr/bin/env bash
# Load or unload the local model (frees the GPU memory at once).
# Run:  bash scripts/local-model.sh on|off|status|unload [--keep URL]
#   unload  the router keeps running but gives back every model it holds, and every model on its own server
#           (PHOSPHOR_LOCAL_URLS, Strata) unloads, except the one at --keep URL. Strata runs this before it loads,
#           so two models never share the GPU; see scripts/setup-strata.sh
# It also unloads by itself after 15 minutes idle and loads again on the next message (see docs/LOCAL-MODEL.md).
set -euo pipefail
UNIT=phosphor-local-model.service
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '"'; }

unload_all() {
  local url key keep="${1:-}"
  url=$(env_value PHOSPHOR_LOCAL_URL)
  key=$(env_value PHOSPHOR_LOCAL_KEY)
  [[ -n "$url" ]] || return 0
  # Every model whose status is not "unloaded" (loaded, loading, sleeping) goes.
  curl -sf --max-time 5 -H "Authorization: Bearer $key" "$url/v1/models" 2>/dev/null |
    python3 -I -c 'import json,sys; [print(m["id"]) for m in json.load(sys.stdin).get("data",[]) if m.get("status",{}).get("value") not in (None,"unloaded")]' |
    while read -r model; do
      curl -sf --max-time 30 -X POST -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
        -d "{\"model\":\"$model\"}" "$url/models/unload" >/dev/null && echo "unloaded: $model"
    done
  # Models on their own servers ("name=url,..."): a loaded one unloads (a running answer may finish, up to 90 s).
  local own
  for own in $(env_value PHOSPHOR_LOCAL_URLS | tr ',' '\n' | sed -n 's/^[^=]*=//p' | sort -u); do
    [[ "$own" == "$keep" ]] && continue
    curl -sf --max-time 2 "$own/health" 2>/dev/null | grep -q '"loaded": *true' || continue
    curl -sf --max-time 95 -X POST -H 'Content-Type: application/json' -d '{}' "$own/unload?wait=90" >/dev/null &&
      echo "unloaded: $own"
  done
  return 0
}

case "${1:-status}" in
  on) systemctl --user start "$UNIT" ;;
  off) systemctl --user stop "$UNIT" ;;
  unload) [[ "${2:-}" == --keep ]] && unload_all "${3:-}" || unload_all ;;
  status) ;;
  *) echo "usage: local-model.sh on|off|status|unload [--keep URL]" >&2; exit 1 ;;
esac
echo "service: $(systemctl --user is-active "$UNIT" || true)"
for f in /sys/class/drm/card*/device/mem_info_vram_used; do
  [[ -r "$f" ]] && echo "GPU memory used: $(($(cat "$f") / 1048576)) MiB"
done
