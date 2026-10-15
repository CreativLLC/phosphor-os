#!/usr/bin/env bash
# Moves a Linux install of Retro Claude (the app's name until 2026-10-12) over to Phosphor-OS.
#
# Run:  bash scripts/migrate-from-retro-claude.sh [--dry-run] [--from DIR] [--yes]
#   --dry-run   print every step, change nothing
#   --from DIR  the old project folder (default: ~/retro-claude)
#   --yes       do not ask before stopping the old app and server
#
# Get the new code first, next to the old folder, then run this script from the new folder:
#   git clone https://github.com/CreativLLC/phosphor-os.git ~/phosphor-os
#   bash ~/phosphor-os/scripts/migrate-from-retro-claude.sh --dry-run     (then again without --dry-run)
# (Or copy the new files over the old folder with rsync and run it there: then nothing moves between folders.)
#
# Run it from a plain terminal (Super + Alt + T), not from a chat in the app: it stops the app and its server.
# Safe to run again: each step looks first and skips what is done.
#
# Steps:
#   1. Packages and the page in the new folder (npm ci, build), before anything is stopped
#   2. Stop the old desktop app and the old server service (retro-claude-server.service), remove that service
#   3. Move data/ (chats list, login key, passkeys, alerts) and .env from the old folder to the new one
#   4. Rename the settings in .env: RETRO_* -> PHOSPHOR_* (the values stay; the app reads both names anyway)
#   5. Move the per-PC folders: ~/.local/share/RetroClaude (Electron, voice engine, website logins),
#      ~/.local/state/RetroClaude (setup notes), the fonts folder, the optional font hook and its notes
#   6. Run scripts/setup-linux.sh from the new folder: it swaps the Hyprland line, the app menu entry and the
#      screensaver plugin for the new names, installs and starts phosphor-os-server.service, and runs the pack.
# The old folder stays (code and node_modules only); delete it once the new app works.

set -euo pipefail

DRY=0
YES=0
FROM="$HOME/retro-claude"

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() {
  printf '\nSTOP: %s\n' "$*" >&2
  exit 1
}
run() {
  if ((DRY)); then
    local out=() a
    for a in "$@"; do out+=("$(printf '%q' "$a")"); done
    say "  [dry-run] ${out[*]}"
  else
    "$@"
  fi
}
ask() { # question -> yes (0) / no (1). --yes and a dry run answer yes.
  if ((YES || DRY)); then return 0; fi
  local reply=""
  { exec 3</dev/tty; } 2>/dev/null || die "No terminal to ask: $1 Run again with --yes."
  read -r -u 3 -p "  $1 [y/N] " reply || true
  exec 3<&-
  [[ $reply == [yY]* ]]
}

while (($#)); do
  case $1 in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    --from)
      FROM=${2:-}
      [[ $# -gt 1 ]] && shift
      ;;
    --from=*) FROM=${1#*=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

NEW="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ -d $FROM ]] && FROM="$(cd "$FROM" && pwd -P)"
xdg() { local v="${!1:-}"; if [[ $v == /* ]]; then printf '%s' "$v"; else printf '%s' "$HOME/$2"; fi; }
DATA_HOME="$(xdg XDG_DATA_HOME .local/share)"
CONFIG_HOME="$(xdg XDG_CONFIG_HOME .config)"
STATE_HOME="$(xdg XDG_STATE_HOME .local/state)"
OLD_UNIT=retro-claude-server.service
OLD_UNIT_FILE="$CONFIG_HOME/systemd/user/$OLD_UNIT"
HOOKS="$HOME/.config/omarchy/hooks/theme-set.d"

[[ $(uname -s) == Linux ]] || die "This is for Linux. Windows: see docs/MIGRATE.md."
((EUID != 0)) || die "Run this as yourself, not as root."
[[ -f $NEW/scripts/setup-linux.sh && -f $NEW/os/hyprland/phosphor-os.lua ]] || die "Run this script from the new Phosphor-OS folder."
# Stopping the old server stops everything it started, this script too if a chat in the app runs it.
if grep -q "$OLD_UNIT" /proc/self/cgroup 2>/dev/null; then
  die "This runs inside the old app's server and would stop itself. Run it from a plain terminal (Super + Alt + T)."
fi

if ((DRY)); then say "DRY RUN: nothing is changed; every step is printed."; fi
say "Old folder: $FROM$([[ -d $FROM ]] || printf ' (not there)')"
say "New folder: $NEW"

# ------------------------------------------------------------------ 1. packages and page

step "1. Packages and the page in the new folder"
node_dir() { # Node 24's bin folder: mise (as setup-linux.sh uses it), else the one on PATH
  local d
  d="$(mise where node@24 2>/dev/null || true)"
  if [[ -n $d && -x $d/bin/npm ]]; then printf '%s' "$d/bin"; else dirname "$(command -v npm 2>/dev/null || echo /usr/bin/npm)"; fi
}
if [[ -d $NEW/node_modules && -f $NEW/web/dist/index.html ]]; then
  say "  Already there."
else
  bin="$(node_dir)"
  [[ -x $bin/npm ]] || ((DRY)) || die "No npm found (Node 24). Run bash $NEW/scripts/setup-linux.sh once, then this again."
  if ((DRY)); then
    say "  [dry-run] (in $NEW) npm ci && npm run build"
  else
    (cd "$NEW" && PATH="$bin:$PATH" npm ci --no-audit --no-fund && PATH="$bin:$PATH" npm run build) ||
      die "npm ci or the build failed. Nothing was stopped or moved."
  fi
fi

# ------------------------------------------------------------------ 2. stop the old app and server

step "2. Stop the old app and its server"
old_app_pid() { # the pid the old desktop app wrote, only if that process really is the app
  local f pid
  for f in "${RETRO_SHELL_DATA:-}/app.pid" "$DATA_HOME/RetroClaude/shell-data/app.pid"; do
    pid="$(cat "$f" 2>/dev/null || true)"
    if [[ $pid =~ ^[0-9]+$ ]] && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'shell/main.mjs'; then
      printf '%s' "$pid"
      return 0
    fi
  done
  return 1
}
pid="$(old_app_pid || true)"
if [[ -z $pid && ! -f $OLD_UNIT_FILE ]]; then
  say "  Nothing runs under the old name."
else
  ask "Stop the old app and its server now? Chats in progress stop." || die "Stopped. Nothing was changed."
  # The app first: it would start the server again on its own.
  if [[ -n $pid ]]; then
    run kill "$pid"
    if ((!DRY)); then
      for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    fi
    say "  Old app stopped (pid $pid)."
  fi
  if [[ -f $OLD_UNIT_FILE ]]; then
    run systemctl --user disable --now "$OLD_UNIT" || true
    run rm -f "$OLD_UNIT_FILE"
    run systemctl --user daemon-reload || true
    ((DRY)) || say "  Old server service stopped and removed: $OLD_UNIT"
  fi
fi

# ------------------------------------------------------------------ 3. data/ and .env

step "3. data/ and .env into the new folder"
move_in() { # name: from the old project to the new one, unless the new one has its own already
  local src="$FROM/$1" dst="$NEW/$1"
  if [[ $FROM == "$NEW" ]]; then
    say "  $1: same folder, stays."
  elif [[ ! -e $src ]]; then
    say "  $1: nothing in the old folder$([[ -e $dst ]] && printf ' (the new folder has its own)')."
  elif [[ -e $dst ]]; then
    die "Both folders have $1. Keep the one you want (the old one has your chats and login), remove the other, run again."
  else
    run mv "$src" "$dst"
  fi
}
move_in data
move_in .env

# ------------------------------------------------------------------ 4. .env names

step "4. Settings in .env: RETRO_* -> PHOSPHOR_*"
ENV_FILE="$NEW/.env"
((DRY)) && [[ ! -f $ENV_FILE && -f $FROM/.env ]] && ENV_FILE="$FROM/.env" # a dry run has not moved it
if [[ ! -f $ENV_FILE ]] || ! grep -q '^RETRO_' "$ENV_FILE"; then
  say "  Nothing to rename."
else
  # Only the names are printed: .env holds the password.
  for key in $(sed -n 's/^RETRO_\([A-Za-z0-9_]*\)=.*/\1/p' "$ENV_FILE" | sort -u); do say "  RETRO_$key -> PHOSPHOR_$key"; done
  if ((!DRY)); then
    tmp="$(mktemp "$ENV_FILE.XXXXXX")"
    # A PHOSPHOR_ line that is there already wins; the old line with the same name goes.
    awk '/^PHOSPHOR_[A-Za-z0-9_]*=/ { split($0, a, "="); have[a[1]] = 1 }
         { lines[NR] = $0 }
         END { for (i = 1; i <= NR; i++) { l = lines[i]
                 if (l ~ /^RETRO_[A-Za-z0-9_]*=/) { sub(/^RETRO_/, "PHOSPHOR_", l); split(l, a, "="); if (a[1] in have) continue; have[a[1]] = 1 }
                 print l } }' "$ENV_FILE" >"$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"
  fi
fi
workspace="$( { sed -n 's/^PHOSPHOR_CWD=//p; s/^RETRO_CWD=//p' "$ENV_FILE" 2>/dev/null || true; } | tail -n 1 | tr -d '\r')"

# ------------------------------------------------------------------ 5. per-PC folders

step "5. Per-PC folders"
move_dir() { # old new
  if [[ ! -e $1 ]]; then
    return 0
  elif [[ -e $2 ]]; then
    say "  Both exist, left alone: $1 and $2 (the app uses the new one)."
  else
    run mv "$1" "$2"
  fi
}
move_dir "$DATA_HOME/RetroClaude" "$DATA_HOME/PhosphorOS"
move_dir "$STATE_HOME/RetroClaude" "$STATE_HOME/PhosphorOS"
move_dir "$DATA_HOME/fonts/retro-claude" "$DATA_HOME/fonts/phosphor-os"
move_dir "$STATE_HOME/retro-claude" "$STATE_HOME/phosphor-os" # the optional font hook's notes
if [[ -f $HOOKS/50-retro-claude-font ]]; then
  run cp "$NEW/os/omarchy/hooks/theme-set.d/50-phosphor-os-font" "$HOOKS/50-phosphor-os-font"
  run rm -f "$HOOKS/50-retro-claude-font"
fi
if [[ -d $DATA_HOME/fonts/phosphor-os ]] && command -v fc-cache >/dev/null; then run fc-cache -f "$DATA_HOME/fonts" >/dev/null; fi
say "  Done."

# ------------------------------------------------------------------ 6. setup under the new names

step "6. scripts/setup-linux.sh (Hyprland line, menu entry, server service, the look)"
args=()
((DRY)) && args+=(--dry-run)
[[ -n $workspace ]] && args+=(--workspace "$workspace")
bash "$NEW/scripts/setup-linux.sh" "${args[@]}"

step "Moved"
say "  Log out and back in (or run: bash $NEW/scripts/phosphor-os.sh --restart) to start the new app."
say "  The phone keeps its address (same port, same Tailscale serve) and stays logged in."
say "  Once it all works, delete the old folder: rm -rf $(printf '%q' "$FROM")"
