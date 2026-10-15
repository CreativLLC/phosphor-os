#!/usr/bin/env bash
# Puts a Phosphor-OS look on Firefox (userChrome.css + userContent.css), or takes it off again.
#
#   install-firefox-theme.sh -Theme retro-amber            (or retro-green, lcars)
#   install-firefox-theme.sh -Theme lcars -Profile ~/.mozilla/firefox/abcd.default-release
#   install-firefox-theme.sh -Undo
#
# Install: backs up the profile's chrome folder and user.js to <profile>/phosphor-os-backup/<time>/,
# copies the theme into <profile>/chrome/, and turns on toolkit.legacyUserProfileCustomizations.stylesheets
# in user.js (Firefox ignores userChrome.css without it).
# Undo: puts back the newest backup and deletes it, so running -Undo again steps back one more install.
# Firefox reads these files when it starts: close it fully and reopen it to see the change.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pref='user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);'
theme=""
profile=""
undo=0

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while (($# > 0)); do
  case "$1" in
    -Theme | --theme | -t)
      theme=${2:-}
      shift 2
      ;;
    -Profile | --profile | -p)
      profile=${2:-}
      shift 2
      ;;
    -Undo | --undo | -u)
      undo=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

default_profile() {
  local root ini path
  # Newer Firefox on Linux keeps profiles under ~/.config/mozilla; older and Flatpak setups elsewhere.
  for root in "${XDG_CONFIG_HOME:-$HOME/.config}/mozilla/firefox" "$HOME/.mozilla/firefox" \
    "$HOME/.var/app/org.mozilla.firefox/config/mozilla/firefox" "$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox" \
    "$HOME/Library/Application Support/Firefox"; do
    ini="$root/profiles.ini"
    [[ -f $ini ]] || continue
    # The [Install...] entry is the profile this Firefox install opens; older setups mark one profile Default=1.
    path=$(tr -d '\r' <"$ini" | awk -F= '
      /^\[/ { sec = $0; next }
      sec ~ /^\[Install/ && $1 == "Default" && inst == "" { inst = substr($0, index($0, "=") + 1) }
      sec ~ /^\[Profile/ {
        if (!(sec in seen)) { seen[sec] = 1; order[++n] = sec }
        if ($1 == "Path") p[sec] = substr($0, index($0, "=") + 1)
        if ($1 == "Default" && $2 == "1") d = sec
      }
      END {
        if (inst != "") print inst
        else if (d != "") print p[d]
        else if (n == 1) print p[order[1]]
      }')
    if [[ -z $path ]]; then
      echo "Could not tell which Firefox profile is the default in $ini. Pass -Profile <folder>." >&2
      exit 1
    fi
    [[ $path == /* ]] || path="$root/$path"
    printf '%s\n' "$path"
    return 0
  done
  echo "No Firefox profiles.ini found. Pass -Profile <folder>." >&2
  exit 1
}

write_user_js() {
  # Add the pref, or switch an existing line for it to true. Everything else in user.js stays as it is.
  local file=$1 tmp
  tmp=$(mktemp)
  if [[ -f $file ]]; then
    awk -v pref="$pref" '
      /toolkit\.legacyUserProfileCustomizations\.stylesheets/ { print pref; found = 1; next }
      { print }
      END { if (!found) print pref }' "$file" >"$tmp"
  else
    printf '%s\n' "$pref" >"$tmp"
  fi
  mv "$tmp" "$file"
}

if ((undo == 0)) && [[ -z $theme ]]; then
  echo "Pass -Theme retro-amber, retro-green or lcars (or -Undo)." >&2
  exit 2
fi
case "$theme" in
  "" | retro-amber | retro-green | lcars) ;;
  *)
    echo "Unknown theme: $theme (use retro-amber, retro-green or lcars)" >&2
    exit 2
    ;;
esac

if [[ -n $profile ]]; then
  prof=$profile
else
  prof=$(default_profile)
fi
if [[ ! -d $prof ]]; then
  echo "Profile folder not found: $prof" >&2
  exit 1
fi
prof=$(cd "$prof" && pwd)
chrome="$prof/chrome"
userjs="$prof/user.js"
backup_root="$prof/phosphor-os-backup"
# Installed under the old name (Retro Claude)? Its backups stay where they are, and undo finds them there.
if [[ ! -e $backup_root && -d $prof/retro-claude-backup ]]; then backup_root="$prof/retro-claude-backup"; fi
echo "Firefox profile: $prof"

if ((undo == 1)); then
  last=""
  if [[ -d $backup_root ]]; then
    last=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)
  fi
  if [[ -z $last ]]; then
    echo "Nothing to undo: no backup found."
    exit 1
  fi
  had_chrome=$(sed -n 's/^had_chrome=//p' "$last/backup.info" | tr -d '\r')
  had_userjs=$(sed -n 's/^had_userjs=//p' "$last/backup.info" | tr -d '\r')
  rm -rf "$chrome"
  [[ $had_chrome == 1 ]] && cp -R "$last/chrome" "$chrome"
  if [[ $had_userjs == 1 ]]; then
    cp "$last/user.js" "$userjs"
  else
    rm -f "$userjs"
  fi
  rm -rf "$last"
  rmdir "$backup_root" 2>/dev/null || true
  echo "Restored the backup from $(basename "$last"). Restart Firefox to see it."
  exit 0
fi

src="$here/$theme"
if [[ ! -f $src/userChrome.css ]]; then
  echo "Theme files missing in $src" >&2
  exit 1
fi

# Back up first; nothing is changed until the backup is complete.
stamp=$(date +%Y%m%d-%H%M%S)
dest="$backup_root/$stamp"
n=1
while [[ -e $dest ]]; do
  dest="$backup_root/$stamp-$n"
  n=$((n + 1))
done
mkdir -p "$dest"
had_chrome=0
had_userjs=0
if [[ -d $chrome ]]; then
  had_chrome=1
  cp -R "$chrome" "$dest/chrome"
fi
if [[ -f $userjs ]]; then
  had_userjs=1
  cp "$userjs" "$dest/user.js"
fi
printf 'theme=%s\nhad_chrome=%s\nhad_userjs=%s\n' "$theme" "$had_chrome" "$had_userjs" >"$dest/backup.info"

rm -rf "$chrome"
mkdir -p "$chrome"
cp "$src/userChrome.css" "$src/userContent.css" "$chrome/"
cp -R "$here/fonts" "$chrome/fonts"
write_user_js "$userjs"

echo "Installed $theme. Backup: $dest"
if pgrep -x firefox >/dev/null 2>&1 || pgrep -x firefox-bin >/dev/null 2>&1; then
  echo "Firefox is running: close it fully and reopen it to see the theme."
else
  echo "Start Firefox to see the theme."
fi
echo "Undo: run this script again with -Undo."
