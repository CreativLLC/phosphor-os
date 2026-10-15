#!/usr/bin/env bash
# Update the Claude Agent SDK (new Claude Code features and models arrive only with it).
#   scripts/update-sdk.sh <X.Y.Z> [--no-restart]
# Installs that version keeping the caret range, checks types and tests, and restarts the server (5 s later, from
# outside, so this script is not killed with it). Any failure puts package.json and package-lock.json back and runs
# `npm ci`. Log: data/update.log. The app's UPDATE button and the 04:00 run call this; it also works by hand.
# --no-restart: skip the restart and the desktop notices (for testing in a copy of the repo).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="@anthropic-ai/claude-agent-sdk"
VERSION="${1:-}"
RESTART=1
[ "${2:-}" = "--no-restart" ] && RESTART=0

# Everything below runs in a memory-capped scope: a runaway npm must not take the whole user session down.
if [ -z "${PHOSPHOR_UPDATE_SCOPED:-}" ] && command -v systemd-run >/dev/null; then
  exec env PHOSPHOR_UPDATE_SCOPED=1 systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 -- bash "$0" "$@"
fi

mkdir -p "$ROOT/data"
LOG="$ROOT/data/update.log"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) script: $*" >> "$LOG"; }
# Test runs (--no-restart, in a copy of the repo) stay quiet: their failures once reached the owner's bell.
say() { [ "$RESTART" = 1 ] && command -v notify-send >/dev/null && notify-send --app-name "Phosphor-OS" "$1" "$2" || true; }

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <X.Y.Z> [--no-restart]" >&2
  exit 2
fi

cd "$ROOT" || exit 1
BACKUP="$(mktemp -d)"
trap 'rm -rf "$BACKUP"' EXIT
cp package.json package-lock.json "$BACKUP/"
log "updating to $VERSION (root $ROOT)"

fail() {
  log "FAILED: $1; putting the old files back"
  cp "$BACKUP/package.json" "$BACKUP/package-lock.json" "$ROOT/"
  npm ci >> "$LOG" 2>&1 || log "npm ci failed too; run it by hand in $ROOT"
  say "Claude Code update failed" "$1. Nothing changed. Details: data/update.log"
  exit 1
}

# --save-exact=false keeps the caret range (^X.Y.Z) in package.json.
npm install "$PKG@$VERSION" --save-exact=false >> "$LOG" 2>&1 || fail "npm install failed"
npx tsc --noEmit -p . >> "$LOG" 2>&1 || fail "the type check failed"
npm run test:router >> "$LOG" 2>&1 || fail "the router tests failed"
log "installed $VERSION, checks passed"

if [ "$RESTART" = 1 ]; then
  # A timer outside this unit: the server cannot restart itself from inside (that would kill this script).
  systemd-run --user -q --on-active=5 systemctl --user restart phosphor-os-server >> "$LOG" 2>&1 \
    || { log "could not schedule the restart; restart the server by hand"; say "Claude Code $VERSION installed" "Restart Phosphor-OS to use it."; exit 1; }
  log "restart in 5 s"
else
  log "restart skipped (--no-restart)"
fi
