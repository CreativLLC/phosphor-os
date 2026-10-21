#!/usr/bin/env bash
# Starts the Phosphor-OS desktop app on Linux, with the Electron that scripts/setup-linux.sh installed.
#
#   phosphor-os.sh              a normal window
#   phosphor-os.sh --desktop    as the desktop: full screen, closing does nothing (Hyprland starts it so at login)
#   phosphor-os.sh --launcher   bring it to the front and open its launcher (the Super key); starts it if needed
#   phosphor-os.sh --docs       bring it to the front on DOCS (the "Phosphor Docs" app menu entry); starts it if needed
#   phosphor-os.sh --docs FILE  the same, and open FILE (.md, .markdown, .mdown, .txt) in DOCS where it is
#                               (a double-clicked Markdown file runs this: the "Phosphor Docs" entry from setup-linux.sh)
#   phosphor-os.sh --restart    stop the running app and start it again as the desktop (the server keeps running)
#
# Only one app runs at a time: a second start hands its request to the running one and exits.

set -u

project="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
data_home="${XDG_DATA_HOME:-}"
[[ $data_home == /* ]] || data_home="$HOME/.local/share"
app="$data_home/PhosphorOS"
# An install from before the rename (Retro Claude) keeps its old folder until it is moved.
if [[ ! -e $app && -d $data_home/RetroClaude ]]; then app="$data_home/RetroClaude"; fi
electron="$app/shell/electron-44.4.5/electron"
shell_data="${PHOSPHOR_SHELL_DATA:-${RETRO_SHELL_DATA:-$app/shell-data}}"

# Shells started by VS Code or Claude Code set this, which makes Electron act as plain Node.
unset ELECTRON_RUN_AS_NODE

if [[ ! -x $electron ]]; then
  echo "Phosphor-OS: Electron is not installed ($electron). Run: bash $project/scripts/setup-linux.sh" >&2
  command -v notify-send >/dev/null && notify-send "Phosphor-OS" "Not installed yet. Run scripts/setup-linux.sh"
  exit 1
fi

if [[ ${1:-} == --restart ]]; then
  # The running app wrote its pid. Stop only that process, and only if it really is this app.
  pid="$(cat "$shell_data/app.pid" 2>/dev/null || true)"
  if [[ $pid =~ ^[0-9]+$ ]] && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'shell/main.mjs'; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  fi
  set -- --desktop
fi

# --docs FILE: the app gets the full path (a running app has another working folder).
args=()
while (($#)); do
  args+=("$1")
  if [[ $1 == --docs && $# -gt 1 && $2 != -* ]]; then
    f="$2"
    [[ $f == /* ]] || f="$PWD/$f"
    args+=("$f")
    shift
  fi
  shift
done
set -- "${args[@]}"

# Native Wayland under Hyprland (Electron picks X11 or Wayland itself with this hint).
exec "$electron" --ozone-platform-hint=auto "$project/shell/main.mjs" "$@"
