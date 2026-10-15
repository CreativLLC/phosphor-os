#!/usr/bin/env bash
# Installs the two fonts the Retro Claude looks use, for your user only (~/.local/share/fonts/retro-claude):
#   VT323    pixel terminal font of the amber/green themes (switch to it with: omarchy font set VT323)
#   Antonio  condensed capitals for LCARS (Firefox and menus use it when it is installed)
# Both come from Google Fonts' official repo at a fixed commit and are checked against a SHA-256 before use.
# Both are under the SIL Open Font License. Undo: install-fonts.sh --undo
# Safe to run again: nothing is downloaded when both are there. --check only says if they are (exit 0 = yes).
set -euo pipefail

dest="${XDG_DATA_HOME:-$HOME/.local/share}/fonts/retro-claude"

if [[ ${1:-} == "--undo" ]]; then
  rm -rf "$dest"
  command -v fc-cache >/dev/null && fc-cache -f "$(dirname "$dest")" >/dev/null
  rmdir "$(dirname "$dest")" 2>/dev/null || true # only when empty
  echo "Removed $dest"
  exit 0
fi

# name|url|sha256
fonts=(
  "VT323-Regular.ttf|https://raw.githubusercontent.com/google/fonts/2da41909d08a7bfeab32cfc163edb7be0c34395d/ofl/vt323/VT323-Regular.ttf|cf4de751ada78ceac033dbe16a687742939995b77bc2a052ae17a4957958594d"
  "Antonio-Variable.ttf|https://raw.githubusercontent.com/google/fonts/95f4904fc8bcf26d3420fe315560c96417c6dec7/ofl/antonio/Antonio%5Bwght%5D.ttf|9e95a2258ecdf3e45c72c5bbea1c4cd350e8f7bebc87c9dba53b29b1890b8903"
)

installed() {
  local entry name sum
  for entry in "${fonts[@]}"; do
    IFS='|' read -r name _ sum <<<"$entry"
    [[ -f $dest/$name && $(sha256sum "$dest/$name" | cut -d' ' -f1) == "$sum" ]] || return 1
  done
}
if [[ ${1:-} == "--check" ]]; then installed && exit 0 || exit 1; fi
if installed; then
  echo "VT323 and Antonio are already in $dest"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for entry in "${fonts[@]}"; do
  IFS='|' read -r name url sum <<<"$entry"
  curl -fsSL --proto '=https' -o "$tmp/$name" "$url"
  got=$(sha256sum "$tmp/$name" | cut -d' ' -f1)
  if [[ $got != "$sum" ]]; then
    echo "Checksum mismatch for $name (got $got). Nothing installed." >&2
    exit 1
  fi
done

mkdir -p "$dest"
for entry in "${fonts[@]}"; do
  IFS='|' read -r name _ _ <<<"$entry"
  install -m 0644 "$tmp/$name" "$dest/$name"
done
command -v fc-cache >/dev/null && fc-cache -f "$dest" >/dev/null
echo "Installed VT323 and Antonio in $dest"
echo "Retro themes: omarchy font set VT323   (or let hooks/theme-set.d/50-retro-claude-font do it)"
