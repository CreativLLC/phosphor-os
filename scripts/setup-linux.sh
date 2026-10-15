#!/usr/bin/env bash
# Sets up Phosphor-OS on Linux and makes it the desktop. Made for Omarchy 4.0.4 (Arch + Hyprland).
#
# Run:  bash scripts/setup-linux.sh [--dry-run] [--undo] [--workspace DIR] [--theme NAME]
#   --dry-run         print every step it would take, change nothing
#   --undo            take back what this script did (asks before the big parts)
#   --workspace DIR   the folder Claude works in (PHOSPHOR_CWD in .env). Otherwise taken from .env, or asked.
#   --theme NAME      the desktop look: retro-amber (default), retro-green or lcars
#
# Safe to run again: each step looks first and skips what is already done.
# It asks before every step that needs sudo. The app stays private: the server listens on 127.0.0.1 only, and
# the phone reaches it through Tailscale "serve" (your own tailnet). Never "funnel" (that is the public internet).
#
# Steps:
#   1. The workspace folder (PHOSPHOR_CWD in .env)
#   2. Node 24 (with mise, which Omarchy ships; see node_step for why)
#   3. npm ci, then build the page
#   4. Voice engine for DICTATE (scripts/setup-voice.sh)
#   5. Electron 44.4.5, the desktop app's runtime (official zip, pinned SHA-256)
#   6. The server as a systemd user service (phosphor-os-server.service), on at every login
#   7. Tailscale serve for the phone (or the steps, when Tailscale is not logged in)
#   8. Desktop mode: app menu entries (Phosphor-OS, and Phosphor Docs, which opens it on DOCS), Hyprland starts
#      Phosphor-OS maximized at login, the Super key opens its launcher (os/hyprland/phosphor-os.lua); then the
#      look: theme, font, the bar at the bottom with a taskbar (os/omarchy/desktop.sh, which also runs alone;
#      docs/OMARCHY.md lists every change)
#
# The project folder is wherever this script is. Keep it OUT of the Nextcloud-synced folder (see docs/LINUX.md):
# this setup fills node_modules, data/ and .env with Linux files, which must not sync to Windows.

set -euo pipefail

DRY=0
UNDO=0
WORKSPACE=""
THEME=""

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '  NOTE: %s\n' "$*"; }
die() {
  printf '\nSTOP: %s\n' "$*" >&2
  exit 1
}
quoted() {
  local out=() a
  for a in "$@"; do out+=("$(printf '%q' "$a")"); done
  printf '%s' "${out[*]}"
}
# Every change goes through run (or write_file): in a dry run it is printed instead.
run() {
  if ((DRY)); then
    say "  [dry-run] $(quoted "$@")"
  else
    "$@"
  fi
}
run_in() { # dir command...
  local dir=$1
  shift
  if ((DRY)); then
    say "  [dry-run] (in $dir) $(quoted "$@")"
  else
    (cd "$dir" && "$@")
  fi
}
write_file() { # path; content on stdin
  if ((DRY)); then
    say "  [dry-run] write $1:"
    sed 's/^/    | /'
  else
    mkdir -p "$(dirname "$1")"
    cat >"$1"
  fi
}
ask() { # question -> yes (0) / no (1). A dry run answers yes, so it shows everything.
  if ((DRY)); then
    say "  [dry-run] would ask: $1 [y/N] (answering yes)"
    return 0
  fi
  local reply=""
  if ! { exec 3</dev/tty; } 2>/dev/null; then
    say "  $1 -> no terminal to ask, so: no."
    return 1
  fi
  read -r -u 3 -p "  $1 [y/N] " reply || true
  exec 3<&-
  [[ $reply == [yY]* ]]
}

for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  case "$arg" in
    --dry-run) DRY=1 ;;
    --undo) UNDO=1 ;;
    --workspace)
      i=$((i + 1))
      WORKSPACE="${!i:-}"
      ;;
    --workspace=*) WORKSPACE="${arg#*=}" ;;
    --theme)
      i=$((i + 1))
      THEME="${!i:-}"
      ;;
    --theme=*) THEME="${arg#*=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
xdg() { # VAR fallback-under-home; the XDG spec says to ignore relative values
  local v="${!1:-}"
  if [[ $v == /* ]]; then printf '%s' "$v"; else printf '%s' "$HOME/$2"; fi
}
# The app's folder in a parent: PhosphorOS, or RetroClaude (its name before the rename, 2026-10-12) while only
# that one exists. scripts/migrate-from-retro-claude.sh moves the old one.
app_dir() { if [[ ! -e $1/PhosphorOS && -d $1/RetroClaude ]]; then printf '%s' "$1/RetroClaude"; else printf '%s' "$1/PhosphorOS"; fi; }
DATA_HOME="$(xdg XDG_DATA_HOME .local/share)"
CONFIG_HOME="$(xdg XDG_CONFIG_HOME .config)"
STATE_HOME="$(xdg XDG_STATE_HOME .local/state)"
APP_DATA="$(app_dir "$DATA_HOME")"
STATE_FILE="$(app_dir "$STATE_HOME")/setup-linux.state"
ENV_FILE="$PROJECT/.env"

ELECTRON_VERSION=44.4.5
ELECTRON_URL="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-linux-x64.zip"
# From the release's SHASUMS256.txt; the npm package's checksums.json has the same value (both checked 2026-10-11).
ELECTRON_SHA256=04586a0ec46c3283fbdaef85530f561f71f0b5e136ad0cb9ef63683615609780
ELECTRON_DIR="$APP_DATA/shell/electron-$ELECTRON_VERSION"

UNIT=phosphor-os-server.service
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT"
HYPR_LUA="$CONFIG_HOME/hypr/hyprland.lua"
HYPR_MARK='-- phosphor-os-desktop'
# Omarchy's own flag file for a hidden bar (its scripts use this path, not XDG_STATE_HOME). Older versions of
# this script hid the bar; it now stays on, because the taskbar lives in it.
BAR_FLAG="$HOME/.local/state/omarchy/toggles/bar-off"
DESKTOP_FILE="$DATA_HOME/applications/phosphor-os.desktop"
DOCS_FILE="$DATA_HOME/applications/phosphor-docs.desktop" # app menu: "Phosphor Docs" opens the app on DOCS
LOOK="$PROJECT/os/omarchy/desktop.sh"
LAUNCH="$PROJECT/scripts/phosphor-os.sh"
ICON="$PROJECT/web/public/icons/icon-192.png"
# The same things under the old name (Retro Claude): setup replaces them, --undo removes them.
OLD_UNIT=retro-claude-server.service
OLD_UNIT_FILE="$CONFIG_HOME/systemd/user/$OLD_UNIT"
OLD_HYPR_MARK='-- retro-claude-desktop'
OLD_DESKTOP_FILE="$DATA_HOME/applications/retro-claude.desktop"

TMPS=()
cleanup() { if ((${#TMPS[@]})); then rm -rf "${TMPS[@]}"; fi; }
trap cleanup EXIT

# ------------------------------------------------------------------ small helpers

remember() { # note what this script did, so --undo takes back only that
  grep -qx "$1=1" "$STATE_FILE" 2>/dev/null && return 0
  if ((DRY)); then
    say "  [dry-run] note in $STATE_FILE: $1"
    return 0
  fi
  mkdir -p "$(dirname "$STATE_FILE")"
  printf '%s=1\n' "$1" >>"$STATE_FILE"
}
did() { grep -qx "$1=1" "$STATE_FILE" 2>/dev/null; }
forget() { # a part was taken back; the note file goes when nothing is left in it
  did "$1" || return 0
  if ((DRY)); then
    say "  [dry-run] drop $1 from $STATE_FILE"
    return 0
  fi
  local rest
  rest="$(grep -vx "$1=1" "$STATE_FILE" || true)"
  if [[ -n $rest ]]; then printf '%s\n' "$rest" >"$STATE_FILE"; else rm -f "$STATE_FILE"; fi
}

# .env settings are PHOSPHOR_<KEY>. RETRO_<KEY> is the name from before the rename and still counts.
env_get() { # KEY
  [[ -f $ENV_FILE ]] || return 0
  local v
  v="$(sed -n "s/^PHOSPHOR_$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r')"
  [[ -n $v ]] || v="$(sed -n "s/^RETRO_$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r')"
  printf '%s' "$v"
}
env_set() { # KEY value: replace the line (either name) or add it; .env holds the password, so only you may read it
  if ((DRY)); then
    say "  [dry-run] set PHOSPHOR_$1=$2 in $ENV_FILE"
    return 0
  fi
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  if [[ -f $ENV_FILE ]]; then grep -v -e "^PHOSPHOR_$1=" -e "^RETRO_$1=" "$ENV_FILE" >"$tmp" || true; fi
  printf 'PHOSPHOR_%s=%s\n' "$1" "$2" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

voice_root() { # the same folder scripts/setup-voice.sh and the server use
  local root="${PHOSPHOR_VOICE_DIR:-${RETRO_VOICE_DIR:-$(env_get VOICE_DIR)}}"
  printf '%s' "${root:-$APP_DATA/voice}"
}

# The folder that a Nextcloud desktop client syncs, if the project is inside one (it keeps .sync_*.db there).
synced_root() {
  local d="$PROJECT"
  while [[ -n $d && $d != / ]]; do
    if compgen -G "$d/.sync_*.db" >/dev/null || compgen -G "$d/._sync_*.db" >/dev/null; then
      printf '%s' "$d"
      return 0
    fi
    d="$(dirname "$d")"
  done
  return 1
}

hypr_reload() {
  if [[ -n ${HYPRLAND_INSTANCE_SIGNATURE:-} ]] && command -v hyprctl >/dev/null; then run hyprctl reload || true; fi
}

# ------------------------------------------------------------------ checks

preflight() {
  [[ $(uname -s) == Linux ]] || die "This is the Linux setup. On Windows use scripts/setup-shell.ps1."
  [[ $(uname -m) == x86_64 ]] || die "Only x86-64 PCs: the pinned Electron and voice engine are x64 builds."
  ((EUID != 0)) || die "Run this as yourself, not as root. It asks for sudo when a step needs it."
  # The project path goes into a Lua string, a systemd unit and a .desktop file: keep it plain.
  [[ $PROJECT != *[\"\\\$\`%$'\n']* ]] || die "The project folder's path has a quote, backslash, \$, %, \` or line break: $PROJECT. Move it to a plain path."
}

synced_check() {
  local root
  root="$(synced_root)" || return 0
  say ""
  say "  This project folder is inside a Nextcloud-synced folder: $root"
  say "  Setting it up here puts Linux files (node_modules, data/, .env) into the sync. They would land on"
  say "  Windows and break Phosphor-OS there. Copy the project out of the synced folder first, for example:"
  say "    rsync -a --exclude node_modules --exclude data --exclude .env --exclude web/dist \\"
  say "      $(printf '%q' "$PROJECT/") ~/phosphor-os/"
  say "    bash ~/phosphor-os/scripts/setup-linux.sh"
  ask "Set up in the synced folder anyway?" || die "Stopped. Nothing was changed."
}

claude_login_check() {
  if [[ -f $HOME/.claude/.credentials.json ]]; then
    say "  Claude Code login: found."
  else
    warn "No Claude Code login found (~/.claude/.credentials.json). Before using the app: run 'claude' in a terminal and log in."
  fi
}

# ------------------------------------------------------------------ 1. workspace

workspace_step() {
  step "1. The folder Claude works in (PHOSPHOR_CWD)"
  local cur
  cur="$(env_get CWD)"
  if [[ -z $WORKSPACE ]]; then
    if [[ -n $cur && $cur == /* && -d $cur ]]; then
      say "  From .env: $cur"
      return 0
    fi
    [[ -z $cur ]] || say "  .env has PHOSPHOR_CWD=$cur, which is not a folder on this PC."
    if ((DRY)); then
      say "  [dry-run] would ask for the folder (your synced workspace) and save it in .env as PHOSPHOR_CWD"
      return 0
    fi
    { exec 3</dev/tty; } 2>/dev/null || die "No terminal to ask for the folder: run again with --workspace DIR."
    read -r -u 3 -p "  Folder Claude works in (full path of your synced workspace): " WORKSPACE || die "No folder given."
    exec 3<&-
  fi
  WORKSPACE="${WORKSPACE/#\~/$HOME}"
  [[ -d $WORKSPACE ]] || die "Not a folder: $WORKSPACE"
  WORKSPACE="$(cd "$WORKSPACE" && pwd -P)"
  if [[ $WORKSPACE == "$cur" ]]; then
    say "  Already set: $WORKSPACE"
  else
    env_set CWD "$WORKSPACE"
    say "  Saved: PHOSPHOR_CWD=$WORKSPACE"
  fi
}

# ------------------------------------------------------------------ 2. Node

NODE=""
node_is_24() { [[ -x $1 ]] && [[ $("$1" -v 2>/dev/null) == v24.* ]]; }

node_step() {
  step "2. Node 24"
  # Why mise: Omarchy ships it and installs its own tools with it (Claude Code too), it needs no sudo, and Node 24
  # sits next to the "latest" Node that Omarchy made the default. The service gets the absolute path of Node 24,
  # so it depends on neither PATH nor mise when it runs. Without mise: Arch's nodejs-lts-krypton (Node 24 LTS).
  if command -v mise >/dev/null; then
    if ! mise where node@24 >/dev/null 2>&1; then
      run mise install node@24 || die "mise could not install Node 24."
    fi
    local dir
    dir="$(mise where node@24 2>/dev/null || true)"
    if [[ -z $dir ]]; then
      ((DRY)) || die "mise has no Node 24."
      dir="$DATA_HOME/mise/installs/node/24"
    fi
    # mise keeps a "24" link to the newest 24.x it has: with it, a later `mise install node@24` updates the service.
    if [[ -L $(dirname "$dir")/24 ]]; then dir="$(dirname "$dir")/24"; fi
    NODE="$dir/bin/node"
  elif node_is_24 /usr/bin/node; then
    NODE=/usr/bin/node
  else
    say "  Node 24 is not installed, and mise is not here."
    if ask "Needs sudo: install Node 24 LTS from Arch (sudo pacman -S --needed nodejs-lts-krypton npm)?"; then
      run sudo pacman -S --needed nodejs-lts-krypton npm || die "pacman did not install Node 24."
    else
      die "Node 24 is needed. Install it, then run this again."
    fi
    NODE=/usr/bin/node
  fi
  if ((!DRY)); then node_is_24 "$NODE" || die "$NODE is not Node 24."; fi
  say "  Node: $NODE"
}

# ------------------------------------------------------------------ 3. packages and page

npm_step() {
  step "3. Packages (npm ci) and the page (vite build)"
  local bin npm
  bin="$(dirname "$NODE")"
  npm="$bin/npm"
  if [[ ! -x $npm ]]; then npm="$(command -v npm || true)"; fi
  [[ -n $npm ]] || ((DRY)) || die "npm not found next to $NODE."
  npm="${npm:-npm}"
  # A Linux install has the Linux build of the Agent SDK; one copied from Windows does not.
  if [[ -d $PROJECT/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64 && $PROJECT/node_modules/.package-lock.json -nt $PROJECT/package-lock.json ]]; then
    say "  Packages already installed."
  else
    run_in "$PROJECT" env PATH="$bin:$PATH" "$npm" ci --no-audit --no-fund || die "npm ci failed."
  fi
  run_in "$PROJECT" env PATH="$bin:$PATH" "$npm" run build || die "The page did not build."
}

# ------------------------------------------------------------------ 4. voice

voice_step() {
  step "4. Voice engine for DICTATE (about 0.7 GB, skipped when already there)"
  local args=()
  if ((DRY)); then args+=(--dry-run); fi
  bash "$PROJECT/scripts/setup-voice.sh" "${args[@]}" || warn "The voice engine did not install. All else works; DICTATE says how to retry (bash scripts/setup-voice.sh)."
}

# ------------------------------------------------------------------ 5. Electron

electron_step() {
  step "5. Electron $ELECTRON_VERSION (the desktop app's runtime)"
  if [[ -x $ELECTRON_DIR/electron ]]; then
    say "  Already installed: $ELECTRON_DIR"
  else
    local unpack=""
    if command -v bsdtar >/dev/null; then unpack=bsdtar; elif command -v unzip >/dev/null; then unpack=unzip; fi
    [[ -n $unpack ]] || ((DRY)) || die "Need bsdtar or unzip to unpack Electron (sudo pacman -S unzip)."
    if ((DRY)); then
      say "  [dry-run] download $ELECTRON_URL into a new empty temp folder"
      say "  [dry-run] check its SHA-256 is $ELECTRON_SHA256, then unpack it into $ELECTRON_DIR"
    else
      local tmp got
      tmp="$(mktemp -d)"
      TMPS+=("$tmp")
      say "  Downloading Electron $ELECTRON_VERSION..."
      curl -fsSL --retry 3 -o "$tmp/electron.zip" "$ELECTRON_URL" || die "Download failed: $ELECTRON_URL"
      got="$(sha256sum "$tmp/electron.zip" | cut -d' ' -f1)"
      [[ $got == "$ELECTRON_SHA256" ]] || die "Hash mismatch for $ELECTRON_URL
  want $ELECTRON_SHA256
  got  $got"
      say "  Hash OK."
      mkdir -p "$tmp/x"
      if [[ $unpack == bsdtar ]]; then bsdtar -xf "$tmp/electron.zip" -C "$tmp/x"; else unzip -q "$tmp/electron.zip" -d "$tmp/x"; fi
      [[ -f $tmp/x/electron ]] || die "The Electron zip has no 'electron' in it."
      chmod +x "$tmp/x/electron"
      rm -rf "$ELECTRON_DIR"
      mkdir -p "$(dirname "$ELECTRON_DIR")"
      mv "$tmp/x" "$ELECTRON_DIR"
      say "  Installed: $ELECTRON_DIR"
    fi
    remember electron
  fi
  electron_libs_check
  sandbox_check
}

# Libraries Electron needs from the system. Read from the binary with readelf (it is not run), looked up in ldconfig.
electron_libs_check() {
  if ((DRY)); then
    say "  [dry-run] check Electron's system libraries (readelf + ldconfig); if some are missing, ask to install them with pacman"
    return 0
  fi
  if ! command -v readelf >/dev/null || ! command -v ldconfig >/dev/null; then
    say "  (Could not check Electron's libraries: readelf is missing. If the app does not open: sudo pacman -S --needed nss gtk3 alsa-lib)"
    return 0
  fi
  local have missing=() lib
  have="$(ldconfig -p 2>/dev/null)"
  while read -r lib; do
    [[ -n $lib ]] || continue
    grep -qF "$lib " <<<"$have" || [[ -e $ELECTRON_DIR/$lib ]] || missing+=("$lib") # some ship in the zip
  done < <(readelf -d "$ELECTRON_DIR/electron" 2>/dev/null | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p')
  if ((${#missing[@]} == 0)); then
    say "  Libraries: all there."
    return 0
  fi
  say "  Missing libraries: ${missing[*]}"
  if command -v pacman >/dev/null && ask "Needs sudo: install Electron's usual libraries (sudo pacman -S --needed nss gtk3 alsa-lib at-spi2-core libcups libxss libxtst libsecret mesa)?"; then
    run sudo pacman -S --needed nss gtk3 alsa-lib at-spi2-core libcups libxss libxtst libsecret mesa || warn "pacman failed; the app may not open."
  fi
}

# Chromium's sandbox uses user namespaces (on in Arch's kernel). Only without them does it need its setuid helper.
sandbox_check() {
  if ((DRY)); then
    say "  [dry-run] check that user namespaces work (unshare -U); only if not: ask to make chrome-sandbox setuid root"
    return 0
  fi
  if unshare --user --map-root-user true 2>/dev/null; then
    say "  Sandbox: user namespaces work."
    return 0
  fi
  local sb="$ELECTRON_DIR/chrome-sandbox"
  say "  User namespaces are off on this PC, so Chromium's sandbox needs its helper to be owned by root."
  if ask "Needs sudo: sudo chown root:root $sb && sudo chmod 4755 $sb ?"; then
    run sudo chown root:root "$sb" && run sudo chmod 4755 "$sb" && remember sandbox_suid
  else
    warn "Without it the app will not start."
  fi
}

# ------------------------------------------------------------------ 6. server service

unit_text() {
  local bin
  bin="$(dirname "$NODE")"
  cat <<EOF
# Phosphor-OS app server: scripts/serve.mjs keeps it running. Made by scripts/setup-linux.sh (--undo removes it).
# It listens on 127.0.0.1 only. Log: $PROJECT/data/server.log
[Unit]
Description=Phosphor-OS app server (localhost only)

[Service]
Type=simple
WorkingDirectory=$PROJECT
# Claude's terminal commands run with this PATH (Omarchy's tools live in ~/.local/bin and mise's shims).
Environment="PATH=$bin:%h/.local/bin:$DATA_HOME/mise/shims:/usr/local/bin:/usr/bin"
ExecStart="$NODE" scripts/serve.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
}

# An install from before the rename runs the server as the old unit, on the same port.
old_service_off() {
  [[ -f $OLD_UNIT_FILE ]] || return 0
  if ask "Stop the server service from before the rename ($OLD_UNIT) and remove it? (Chats in progress stop.)"; then
    run systemctl --user disable --now "$OLD_UNIT" || true
    run rm -f "$OLD_UNIT_FILE"
    run systemctl --user daemon-reload || true
  else
    warn "$OLD_UNIT stays (it holds the port: $UNIT cannot start while it runs)."
    return 1
  fi
}

service_step() {
  step "6. The server as a service (starts at login, restarts if it crashes)"
  if ! command -v systemctl >/dev/null; then
    warn "No systemctl here. The desktop app starts the server itself when it is not running."
    return 0
  fi
  old_service_off || return 0
  local text changed=0 was_active=0
  text="$(unit_text)"
  if [[ -f $UNIT_FILE && "$(cat "$UNIT_FILE")" == "$text" ]]; then
    say "  Service file already in place: $UNIT_FILE"
  else
    printf '%s\n' "$text" | write_file "$UNIT_FILE"
    ((DRY)) || say "  Wrote $UNIT_FILE"
    changed=1
    remember service
  fi
  if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then was_active=1; fi
  if ((changed)); then run systemctl --user daemon-reload; fi
  run systemctl --user enable --now "$UNIT"
  ((DRY)) || say "  Server service on: $UNIT (log: $PROJECT/data/server.log)"
  if ((changed && was_active)); then
    say "  The service file changed: restarting the server (open chats reconnect)."
    run systemctl --user restart "$UNIT"
  fi
}

# ------------------------------------------------------------------ 7. Tailscale

tailscale_steps() {
  say "  For the phone, later:"
  say "    1. sudo pacman -S --needed tailscale"
  say "    2. sudo systemctl enable --now tailscaled"
  say "    3. sudo tailscale up --operator=\$USER    (open the link it prints and log in)"
  say "    4. Run this setup again: it adds 'tailscale serve' for port $1."
}

tailscale_step() {
  local port
  port="$(env_get PORT)"
  port="${port:-7337}"
  step "7. Phone access over Tailscale (private to your tailnet)"
  if ! command -v tailscale >/dev/null; then
    say "  Tailscale is not installed."
    tailscale_steps "$port"
    return 0
  fi
  if ! tailscale status >/dev/null 2>&1; then
    say "  Tailscale is not running or not logged in."
    tailscale_steps "$port"
    return 0
  fi
  if tailscale serve status 2>/dev/null | grep -qE "(127\.0\.0\.1|localhost):$port\b"; then
    say "  Already served: port $port."
    return 0
  fi
  if run tailscale serve --bg "$port"; then
    ((DRY)) || say "  Tailscale serve on for port $port ('tailscale serve status' shows the https address)."
    remember tailscale_serve
  else
    say "  Tailscale said no: your user may not manage it yet."
    if ask "Needs sudo once: let your user manage Tailscale (sudo tailscale set --operator=$USER)?"; then
      if run sudo tailscale set --operator="$USER" && run tailscale serve --bg "$port"; then
        remember tailscale_serve
      else
        warn "Tailscale serve is not on. Try: tailscale serve --bg $port"
      fi
    fi
  fi
}

# ------------------------------------------------------------------ 8. desktop mode

desktop_entry() {
  cat <<EOF
[Desktop Entry]
Type=Application
Name=Phosphor-OS
Comment=Claude Code in a ship-computer look
Exec=bash "$LAUNCH"
Icon=$ICON
Terminal=false
Categories=Development;
StartupWMClass=phosphor-os
EOF
}

docs_entry() {
  cat <<EOF
[Desktop Entry]
Type=Application
Name=Phosphor Docs
Comment=Phosphor-OS's documents: notes, letters, lists
Exec=bash "$LAUNCH" --docs
Icon=$ICON
Terminal=false
Categories=Office;TextEditor;
Keywords=docs;documents;notes;markdown;writer;
EOF
}

menu_entry() { # file entry: write it unless it is already exactly that
  if [[ -f $1 && "$(cat "$1")" == "$2" ]]; then
    say "  App menu entry already there: $(basename "$1")."
  else
    printf '%s\n' "$2" | write_file "$1"
  fi
}

desktop_step() {
  step "8. Desktop mode (Hyprland)"
  # Omarchy's app menu entries. The first one's name also gives the window its class, phosphor-os (see
  # shell/main.mjs). The second opens the same app straight on DOCS (Super+Space, "doc").
  menu_entry "$DESKTOP_FILE" "$(desktop_entry)"
  menu_entry "$DOCS_FILE" "$(docs_entry)"
  if [[ -f $OLD_DESKTOP_FILE ]]; then run rm -f "$OLD_DESKTOP_FILE"; fi

  if [[ ! -f $HYPR_LUA ]]; then
    if [[ -f $CONFIG_HOME/hypr/hyprland.conf ]]; then
      warn "This Hyprland uses hyprland.conf, not Omarchy 4's hyprland.lua. Desktop mode is made for Omarchy 4; skipped."
    else
      warn "No Hyprland config at $HYPR_LUA; desktop mode skipped."
    fi
    return 0
  fi

  drop_hypr_line "$OLD_HYPR_MARK" # the line from before the rename; the new one replaces it
  if grep -qF -e "$HYPR_MARK" "$HYPR_LUA"; then
    say "  hyprland.lua already loads Phosphor-OS's desktop mode."
  else
    local backup="$HYPR_LUA.phosphor-os-backup"
    if [[ -e $backup ]]; then backup="$backup-$(date +%Y%m%d-%H%M%S)"; fi
    run cp -p "$HYPR_LUA" "$backup"
    local line="phosphor_os_dir = \"$PROJECT\"; dofile(phosphor_os_dir .. \"/os/hyprland/phosphor-os.lua\") $HYPR_MARK (scripts/setup-linux.sh; --undo removes this line)"
    if ((DRY)); then
      say "  [dry-run] add one line at the end of $HYPR_LUA:"
      say "    | $line"
    else
      # Start on a new line without adding a blank one, so --undo gives back the file exactly.
      if [[ -s $HYPR_LUA && -n $(tail -c 1 "$HYPR_LUA") ]]; then printf '\n' >>"$HYPR_LUA"; fi
      printf '%s\n' "$line" >>"$HYPR_LUA"
      say "  Added one line to $HYPR_LUA (backup: $backup)."
    fi
    remember hypr_line
  fi

  # An older version hid the bar (`omarchy-toggle-bar on` sets the "bar-off" flag): show it again.
  if did bar_hidden; then
    if [[ -f $BAR_FLAG ]] && command -v omarchy-toggle-bar >/dev/null; then run omarchy-toggle-bar off; fi
    forget bar_hidden
  fi
  hypr_reload

  if command -v omarchy >/dev/null; then
    local args=()
    if ((DRY)); then args+=(--dry-run); fi
    if [[ -n $THEME ]]; then args+=(--theme "$THEME"); fi
    PHOSPHOR_NODE="$NODE" bash "$LOOK" "${args[@]}" || warn "The look did not go on fully. Run it again: bash $LOOK"
  else
    say "  No 'omarchy' command: the look (theme, font, bar) is skipped."
  fi
}

drop_hypr_line() { # mark: take out the line that carries it
  [[ -f $HYPR_LUA ]] && grep -qF -e "$1" "$HYPR_LUA" || return 0
  if ((DRY)); then
    say "  [dry-run] remove the line with '$1' from $HYPR_LUA"
  else
    local tmp
    tmp="$(mktemp)"
    TMPS+=("$tmp")
    grep -vF -e "$1" "$HYPR_LUA" >"$tmp" || true
    cat "$tmp" >"$HYPR_LUA" # keeps the file's owner, mode and any symlink
    say "  Removed the line with '$1' from $HYPR_LUA (the backup from setup is still next to it)."
  fi
}

# ------------------------------------------------------------------ undo

undo() {
  step "Undo"
  local args=()
  if ((DRY)); then args+=(--dry-run); fi
  bash "$LOOK" --undo "${args[@]}"
  drop_hypr_line "$HYPR_MARK"
  drop_hypr_line "$OLD_HYPR_MARK"
  forget hypr_line
  if did bar_hidden && command -v omarchy-toggle-bar >/dev/null; then
    run omarchy-toggle-bar off
    say "  Top bar shown again."
    forget bar_hidden
  fi
  if [[ -f $DESKTOP_FILE ]]; then run rm -f "$DESKTOP_FILE"; fi
  if [[ -f $DOCS_FILE ]]; then run rm -f "$DOCS_FILE"; fi
  if [[ -f $OLD_DESKTOP_FILE ]]; then run rm -f "$OLD_DESKTOP_FILE"; fi
  hypr_reload

  if [[ -f $UNIT_FILE ]] && ask "Stop the Phosphor-OS server and remove its service? (Chats in progress stop.)"; then
    run systemctl --user disable --now "$UNIT" || true
    run rm -f "$UNIT_FILE"
    run systemctl --user daemon-reload || true
    forget service
  fi
  old_service_off || true
  [[ -f $UNIT_FILE || -f $OLD_UNIT_FILE ]] || forget service
  if did tailscale_serve && command -v tailscale >/dev/null; then
    if ask "Turn off Tailscale serve? ('tailscale serve reset' removes every serve rule on this PC.)"; then
      run tailscale serve reset || true
      forget tailscale_serve
    fi
  fi
  if [[ -d $ELECTRON_DIR ]] && ask "Remove Electron ($ELECTRON_DIR, about 300 MB)?"; then
    run rm -rf "$ELECTRON_DIR"
    forget electron
    forget sandbox_suid
  fi
  local voice
  voice="$(voice_root)"
  if [[ -d $voice ]] && ask "Remove the voice engine ($voice, about 0.7 GB)?"; then
    run rm -rf "$voice"
  fi
  say ""
  say "  Left in place: Node 24 (mise or pacman), node_modules and web/dist in the project, .env (password and"
  say "  PHOSPHOR_CWD), the project's data/ folder (chats list, log), the app's own data ($APP_DATA/shell-data:"
  say "  website logins and settings), and the Tailscale operator setting. Delete them by hand if you want."
  say "  Done. Log out and back in to get Omarchy's normal desktop."
}

# ------------------------------------------------------------------ main

preflight
if ((DRY)); then say "DRY RUN: nothing is changed; every step is printed."; fi
say "Project: $PROJECT"

if ((UNDO)); then
  undo
  exit 0
fi

synced_check
claude_login_check
workspace_step
node_step
npm_step
voice_step
electron_step
service_step
tailscale_step
desktop_step

step "Done"
if [[ -f $HYPR_LUA ]]; then
  say "  Log out and back in (or reboot): Phosphor-OS starts maximized as the desktop, under the bar."
  say "  Keys: Super + Space = open apps.  Super + Alt + R = restart Phosphor-OS.  Super + Alt + T = a plain terminal."
  say "  Super + T = full size under the bar.  Super + F = real full screen.  Super + Shift + T = floating on/off."
  say "  Omarchy's own keys still work (Super + Space menu, Super + Return terminal). All keys: docs/LINUX.md."
else
  say "  Start the app with: bash $(printf '%q' "$LAUNCH")   (or Phosphor-OS in the app menu)"
fi
say "  Take it all back: bash scripts/setup-linux.sh --undo"
