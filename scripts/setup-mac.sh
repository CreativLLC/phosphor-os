#!/usr/bin/env bash
# Sets up the Phosphor-OS app on an Apple Silicon Mac (app only: the desktop look is Omarchy's, Linux only).
# UNTESTED on a real Mac so far: read docs/MAC.md first, and run --dry-run before the real run.
#
# Run:  bash scripts/setup-mac.sh [--dry-run] [--undo] [--workspace DIR]
#   --dry-run         print every step it would take, change nothing
#   --undo            take back what this script did (asks before each part)
#   --workspace DIR   the folder Claude works in (PHOSPHOR_CWD in .env). Otherwise taken from .env, or asked.
#
# Safe to run again: each step looks first and skips what is already done. No step needs sudo.
# The app stays private: the server listens on 127.0.0.1 only, and the phone reaches it through Tailscale "serve"
# (your own tailnet). Never "funnel" (that is the public internet).
#
# Steps:
#   1. The workspace folder (PHOSPHOR_CWD in .env)
#   2. Node 24 (Homebrew's node@24; this script never installs Homebrew itself)
#   3. npm ci, then build the page
#   4. Voice engine for DICTATE (scripts/setup-voice.sh)
#   5. Electron 44.4.5 as ~/Applications/Phosphor-OS.app (official zip, pinned SHA-256, signed again ad hoc
#      because the app folder is added to it)
#   6. The server as a launchd agent (os.phosphor.server), on at every login; the app at login, in the menu bar
#   7. Tailscale serve for the phone (or the steps, when Tailscale is not logged in)
#
# Keep the project folder OUT of a synced folder (Nextcloud, iCloud, Dropbox): node_modules, data/ and .env are
# this Mac's own files.

set -euo pipefail

DRY=0
UNDO=0
WORKSPACE=""

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '  NOTE: %s\n' "$*"; }
die() {
  printf '\nSTOP: %s\n' "$*" >&2
  exit 1
}
run() {
  if ((DRY)); then
    say "  [dry-run] $*"
  else
    "$@"
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

i=1
while ((i <= $#)); do
  arg="${!i}"
  case "$arg" in
    --dry-run) DRY=1 ;;
    --undo) UNDO=1 ;;
    --workspace)
      i=$((i + 1))
      WORKSPACE="${!i:-}"
      ;;
    --workspace=*) WORKSPACE="${arg#*=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
  i=$((i + 1))
done

[[ $(uname -s) == Darwin ]] || die "This is the Mac setup. Linux: scripts/setup-linux.sh. Windows: see README.md."
[[ $(uname -m) == arm64 ]] || die "Only Apple Silicon Macs (M1 and later) are supported (the pinned files are arm64)."

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$PROJECT/.env"
APP_DATA="$HOME/.local/share/PhosphorOS" # the same folder the server and the app use on Linux and Mac
STATE_FILE="$APP_DATA/setup-mac.state"
AGENTS="$HOME/Library/LaunchAgents"
SERVER_AGENT=os.phosphor.server
APP_AGENT=os.phosphor.app
SERVER_PLIST="$AGENTS/$SERVER_AGENT.plist"
APP_PLIST="$AGENTS/$APP_AGENT.plist"
APP="$HOME/Applications/Phosphor-OS.app"
APP_BIN="$APP/Contents/MacOS/Electron"
GUI="gui/$(id -u)"

ELECTRON_VERSION=44.4.5
ELECTRON_URL="https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-darwin-arm64.zip"
# The release's SHASUMS256.txt (checked 2026-10-21).
ELECTRON_SHA256=a212eee63ba2f45fd83bd28f77a3e3313a336ad17a4c25adf617942eef5e0e2c

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

env_get() { [[ -f $ENV_FILE ]] && sed -n "s/^PHOSPHOR_$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r' || true; }
env_set() { # KEY value: replace the line or add it; .env holds the password, so only you may read it
  if ((DRY)); then
    say "  [dry-run] set PHOSPHOR_$1=$2 in $ENV_FILE"
    return 0
  fi
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  if [[ -f $ENV_FILE ]]; then grep -v -e "^PHOSPHOR_$1=" "$ENV_FILE" >"$tmp" || true; fi
  printf 'PHOSPHOR_%s=%s\n' "$1" "$2" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

DL_DIR=""
trap '[[ -n $DL_DIR ]] && rm -rf "$DL_DIR"' EXIT

node_url() { # a file path as a file:// URL for an ES import
  "$NODE" -e 'process.stdout.write(require("node:url").pathToFileURL(process.argv[1]).href)' "$1"
}

xml() { # escape for a plist string
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  printf '%s' "${s//>/&gt;}"
}

# ------------------------------------------------------------------ 1. workspace

workspace_step() {
  step "1. The folder Claude works in"
  local cur
  cur="$(env_get CWD)"
  if [[ -z $WORKSPACE ]]; then
    if [[ -n $cur ]]; then
      say "  Already set: $cur"
      return 0
    fi
    if ((DRY)); then
      say "  [dry-run] would ask for the folder and save it in .env as PHOSPHOR_CWD"
      return 0
    fi
    { exec 3</dev/tty; } 2>/dev/null || die "No terminal to ask for the folder: run again with --workspace DIR."
    read -r -u 3 -p "  Folder Claude works in (full path): " WORKSPACE || die "No folder given."
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
  # The agents get this absolute path, so they depend on no PATH. node@24 is "keg-only": brew does not link it.
  local c
  for c in "${PHOSPHOR_NODE:-}" /opt/homebrew/opt/node@24/bin/node "$(command -v node || true)"; do
    if [[ -n $c ]] && node_is_24 "$c"; then
      NODE="$c"
      break
    fi
  done
  if [[ -z $NODE ]]; then
    command -v brew >/dev/null || die "Node 24 is needed. Install Homebrew first (https://brew.sh), then run this again."
    if ask "Install Node 24 with Homebrew (brew install node@24)?"; then
      run brew install node@24 || die "brew did not install Node 24."
    else
      die "Node 24 is needed. Install it, then run this again."
    fi
    NODE=/opt/homebrew/opt/node@24/bin/node
  fi
  if ((!DRY)); then node_is_24 "$NODE" || die "$NODE is not Node 24."; fi
  say "  Node: $NODE"
}

# ------------------------------------------------------------------ 3. packages and page

npm_step() {
  step "3. Packages (npm ci) and the page (vite build)"
  local bin
  bin="$(dirname "$NODE")"
  # A Mac install has the Mac build of the Agent SDK; a folder copied from another PC does not.
  if [[ -d $PROJECT/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64 && $PROJECT/node_modules/.package-lock.json -nt $PROJECT/package-lock.json ]]; then
    say "  Packages already installed."
  else
    (cd "$PROJECT" && run env PATH="$bin:$PATH" "$bin/npm" ci --no-audit --no-fund) || die "npm ci failed."
  fi
  (cd "$PROJECT" && run env PATH="$bin:$PATH" "$bin/npm" run build) || die "The page did not build."
}

# ------------------------------------------------------------------ 4. voice

voice_step() {
  step "4. Voice engine for DICTATE (about 0.7 GB, skipped when already there)"
  local args=()
  if ((DRY)); then args+=(--dry-run); fi
  bash "$PROJECT/scripts/setup-voice.sh" ${args[@]+"${args[@]}"} || warn "The voice engine did not install. All else works; DICTATE says how to retry (bash scripts/setup-voice.sh)."
}

# ------------------------------------------------------------------ 5. the app

# Electron loads the folder Contents/Resources/app by itself. Its index.mjs only imports this project's
# shell/main.mjs (Electron joins "main" to the app folder, so it cannot name a file outside it). The bundle is
# Electron's own, renamed.
app_step() {
  step "5. The desktop app: $APP (Electron $ELECTRON_VERSION)"
  local main="$PROJECT/shell/main.mjs"
  local want
  want="import '$(node_url "$main" 2>/dev/null || printf 'file://%s' "$main")';"
  if [[ -x $APP_BIN ]] && [[ $(cat "$APP/Contents/Resources/app/index.mjs" 2>/dev/null) == "$want" ]] &&
    grep -q "$ELECTRON_VERSION" "$APP/Contents/Resources/phosphor-electron-version" 2>/dev/null; then
    say "  Already installed."
    return 0
  fi
  if ((DRY)); then
    say "  [dry-run] download $ELECTRON_URL, check its SHA-256 is $ELECTRON_SHA256"
    say "  [dry-run] unpack it as $APP, add Contents/Resources/app (it starts $main), name it Phosphor-OS, sign it again ad hoc"
    remember app
    return 0
  fi
  local dl got
  dl="$(mktemp -d)"
  DL_DIR="$dl" # removed at exit, also when a step stops the script
  say "  Downloading Electron $ELECTRON_VERSION..."
  curl -fsSL --retry 3 -o "$dl/electron.zip" "$ELECTRON_URL" || die "Download failed: $ELECTRON_URL"
  got="$(shasum -a 256 "$dl/electron.zip" | cut -d' ' -f1)"
  [[ $got == "$ELECTRON_SHA256" ]] || die "Hash mismatch for $ELECTRON_URL
  want $ELECTRON_SHA256
  got  $got"
  say "  sha256 ok"
  ditto -xk "$dl/electron.zip" "$dl/x" || die "Unpack failed."
  [[ -d $dl/x/Electron.app ]] || die "No Electron.app in the zip."
  local plist="$dl/x/Electron.app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Phosphor-OS" "$plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Phosphor-OS" "$plist" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Phosphor-OS" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier os.phosphor.app" "$plist"
  # DICTATE: macOS shows this line when it asks for the microphone.
  /usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string Phosphor-OS uses the microphone for DICTATE (speech to text on this Mac)." "$plist"
  # The floating mic presses Command+V through System Events to put dictated words into other apps (shell/dictate.mjs).
  /usr/libexec/PlistBuddy -c "Delete :NSAppleEventsUsageDescription" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string Phosphor-OS presses Command+V to put dictated words into the app you are typing in." "$plist"
  local appdir="$dl/x/Electron.app/Contents/Resources/app"
  mkdir -p "$appdir"
  printf '%s\n' '{"name":"phosphor-os","productName":"Phosphor-OS","main":"index.mjs"}' >"$appdir/package.json"
  printf '%s' "$want" >"$appdir/index.mjs"
  printf '%s\n' "$ELECTRON_VERSION" >"$dl/x/Electron.app/Contents/Resources/phosphor-electron-version"
  app_icon "$dl" "$dl/x/Electron.app/Contents/Resources/electron.icns"
  # The added files break Electron's signature; an Apple Silicon Mac runs only signed code, so sign it again
  # ad hoc (for this Mac only, no Apple account needed).
  codesign --force --deep --sign - "$dl/x/Electron.app" || die "codesign failed."
  mkdir -p "$(dirname "$APP")"
  rm -rf "$APP"
  mv "$dl/x/Electron.app" "$APP"
  rm -rf "$dl"
  remember app
  say "  Installed: $APP (Spotlight: Phosphor-OS)"
}

app_icon() { # tmpdir dest.icns: the app's own icon from the page's 512 px PNG
  local png="$PROJECT/web/public/icons/icon-512.png" set="$1/icon.iconset" s
  [[ -f $png ]] || return 0
  mkdir -p "$set"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$png" --out "$set/icon_${s}x${s}.png" >/dev/null 2>&1 || return 0
    sips -z $((s * 2)) $((s * 2)) "$png" --out "$set/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || return 0
  done
  iconutil -c icns "$set" -o "$2" 2>/dev/null || warn "Kept Electron's icon (iconutil failed)."
}

# ------------------------------------------------------------------ 6. launchd agents

server_plist() {
  local bin
  bin="$(dirname "$NODE")"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Phosphor-OS app server: scripts/serve.mjs keeps it running. Made by scripts/setup-mac.sh (its undo removes it).
     It listens on 127.0.0.1 only. Log: data/server.log in the project. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_AGENT</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "$NODE")</string><string>scripts/serve.mjs</string></array>
  <key>WorkingDirectory</key><string>$(xml "$PROJECT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- Claude's terminal commands run with this PATH (Homebrew, Claude Code in ~/.local/bin). -->
    <key>PATH</key><string>$(xml "$bin:$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- serve.mjs exits 0 when another copy already runs: then it stays stopped. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$(xml "$APP_DATA/serve-launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$APP_DATA/serve-launchd.log")</string>
</dict>
</plist>
EOF
}

app_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Phosphor-OS at login, in the menu bar only (the hidden flag). Made by scripts/setup-mac.sh (its undo removes it). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$APP_AGENT</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "$APP_BIN")</string><string>--hidden</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF
}

install_agent() { # label file text
  local label="$1" file="$2" text="$3"
  if [[ -f $file ]] && [[ $(cat "$file") == "$text" ]] && launchctl print "$GUI/$label" >/dev/null 2>&1; then
    say "  Already on: $label"
    return 0
  fi
  if ((DRY)); then
    say "  [dry-run] write $file, then launchctl bootstrap $GUI $file"
    remember "agent_$label"
    return 0
  fi
  mkdir -p "$AGENTS" "$APP_DATA"
  launchctl bootout "$GUI/$label" 2>/dev/null || true
  printf '%s\n' "$text" >"$file"
  launchctl bootstrap "$GUI" "$file" || die "launchctl did not load $file."
  remember "agent_$label"
  say "  On: $label"
}

agents_step() {
  step "6. The server at every login (launchd), and the app in the menu bar at login"
  install_agent "$SERVER_AGENT" "$SERVER_PLIST" "$(server_plist)"
  if ((!DRY)); then
    local n
    for n in $(seq 1 60); do
      curl -fsS -o /dev/null "http://127.0.0.1:$(env_get PORT | grep -E '^[0-9]+$' || echo 7337)/" 2>/dev/null && break
      sleep 1
    done
    say "  Server log: $PROJECT/data/server.log"
  fi
  if ask "Start Phosphor-OS in the menu bar at every login?"; then
    install_agent "$APP_AGENT" "$APP_PLIST" "$(app_plist)"
  fi
}

# ------------------------------------------------------------------ 7. Tailscale

tailscale_bin() {
  if command -v tailscale >/dev/null; then
    command -v tailscale
  elif [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
    printf '%s' /Applications/Tailscale.app/Contents/MacOS/Tailscale
  fi
}

tailscale_step() {
  local port ts
  port="$(env_get PORT)"
  port="${port:-7337}"
  step "7. Phone access over Tailscale (private to your tailnet)"
  ts="$(tailscale_bin)"
  if [[ -z $ts ]] || ! "$ts" status >/dev/null 2>&1; then
    say "  Tailscale is not installed or not logged in. For the phone, later:"
    say "    1. Install Tailscale from the Mac App Store or tailscale.com, open it and log in."
    say "    2. Run this setup again: it adds 'tailscale serve' for port $port."
    return 0
  fi
  if "$ts" serve status 2>/dev/null | grep -qE "(127\.0\.0\.1|localhost):$port\b"; then
    say "  Already served: port $port."
    return 0
  fi
  if run "$ts" serve --bg "$port"; then
    ((DRY)) || say "  Tailscale serve on for port $port ('tailscale serve status' shows the https address)."
    remember tailscale_serve
  else
    warn "Tailscale serve is not on. Try: $ts serve --bg $port"
  fi
}

# ------------------------------------------------------------------ undo

undo() {
  step "Undo: taking back what setup-mac.sh did"
  local label file
  for label in "$APP_AGENT" "$SERVER_AGENT"; do
    file="$AGENTS/$label.plist"
    if did "agent_$label" && ask "Remove the launchd agent $label (stops it)?"; then
      run launchctl bootout "$GUI/$label" 2>/dev/null || true
      run rm -f "$file"
    fi
  done
  if did app && [[ -d $APP ]] && ask "Remove $APP?"; then run rm -rf "$APP"; fi
  if did tailscale_serve && [[ -n $(tailscale_bin) ]] && ask "Turn off Tailscale serve?"; then run "$(tailscale_bin)" serve reset || true; fi
  say "  Kept: the project folder, .env, data/, Node and the voice engine ($APP_DATA/voice). Remove them by hand if you want."
  ((DRY)) || rm -f "$STATE_FILE"
}

# ------------------------------------------------------------------ main

if ((UNDO)); then
  undo
  exit 0
fi
((DRY)) && say "Dry run: nothing is changed."
command -v claude >/dev/null || [[ -x $HOME/.local/bin/claude ]] || warn "Claude Code was not found. Install it and log in once in Terminal (claude), or chats will say you are not logged in."
workspace_step
node_step
npm_step
voice_step
app_step
agents_step
tailscale_step
step "Done"
say "  Open Phosphor-OS from Spotlight or ~/Applications. Log in with PHOSPHOR_PASSWORD from $ENV_FILE (made at the server's first start)."
say "  The first DICTATE asks for the microphone: allow it."
