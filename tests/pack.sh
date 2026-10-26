#!/usr/bin/env bash
# Tests for the add-on pack (os/omarchy/desktop.sh), setup-linux.sh --undo and the migration from Retro Claude.
# Everything runs in fake home folders under a temp folder, with stand-in commands first on PATH (omarchy,
# hyprctl, systemctl, tailscale, curl, mise, sudo, ...). Nothing touches your real desktop, services or files.
#
# Run:  bash tests/pack.sh          (needs jq, script, unshare, rsync, curl; Node 24 on PATH; npm ci and
#                                     npm run build done in the project, for the migration case)
# Without Omarchy (CI), its default shell.json comes from tests/fixtures/omarchy-shell.json.
# Keep the temp folder for a look afterwards: PACKTEST_KEEP=1 bash tests/pack.sh
set -uo pipefail

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# A missing tool skips the test here, but fails it in CI (where the workflow installs them all).
missing() { echo "SKIP: needs $*"; [[ -z ${CI:-} ]] || exit 1; exit 0; }
for t in jq script unshare rsync curl sha256sum timeout node; do command -v "$t" >/dev/null || missing "$t"; done
[[ -d $R/node_modules && -f $R/web/dist/index.html && -f $R/web/dist/saver/saver.html ]] || missing "npm ci and npm run build in $R"
[[ $(node -v) == v24.* ]] || { echo "Needs Node 24 first on PATH"; exit 1; }
NODE_BIN="$(dirname "$(command -v node)")"

T="$(mktemp -d "${TMPDIR:-/tmp}/packtest.XXXXXX")"
[[ ${PACKTEST_KEEP:-} == 1 ]] && echo "Test folder: $T" || trap 'rm -rf "$T"' EXIT
D=$R/os/omarchy/desktop.sh
SV=$R/os/omarchy/screensaver
PAGE=$R/web/dist/saver # the built screensaver page, which desktop.sh puts into the plugin as page/
# svsame DIR: the installed screensaver plugin is the pack's folder plus the built page
svsame() { diff -r -x page "$SV" "$1" && diff -r "$PAGE" "$1/page"; }
NF=$R/os/omarchy/notifications
CK=$R/os/omarchy/clock
OLD=$R/tests/fixtures/retro-claude-pack # desktop.sh and install-fonts.sh as they were before the rename
FLOAT=$R/tests/fixtures/floating-mic-pack # desktop.sh as it was while the floating mic existed (until 2026-10-26)
OMARCHY_JSON=${OMARCHY_PATH:-/usr/share/omarchy}/config/omarchy/shell.json # where desktop.sh reads it
if [[ ! -f $OMARCHY_JSON ]]; then # a stand-in Omarchy folder with its default shell.json (Omarchy 4.0.4, MIT)
  export OMARCHY_PATH=$T/omarchy
  OMARCHY_JSON=$OMARCHY_PATH/config/omarchy/shell.json
  mkdir -p "${OMARCHY_JSON%/*}" && cp "$R/tests/fixtures/omarchy-shell.json" "$OMARCHY_JSON"
  echo "No Omarchy here: using tests/fixtures/omarchy-shell.json"
elif ! cmp -s "$OMARCHY_JSON" "$R/tests/fixtures/omarchy-shell.json"; then
  echo "NOTE: Omarchy's shell.json differs from tests/fixtures/omarchy-shell.json; copy it over so CI tests the same."
fi

PASS=0 FAIL=0
ok() { echo "PASS: $*"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
check() { local what=$1; shift; if "$@" >/dev/null; then ok "$what"; else bad "$what"; fi; }

# ------------------------------------------------------------------ stand-ins and fonts

mkdir -p "$T/stubs" "$T/fonts"
stub() { printf '#!/bin/bash\necho "%s $*" >>"$STUBLOG"\n%s\n' "$1" "${2:-}" >"$T/stubs/$1"; chmod +x "$T/stubs/$1"; }
stub omarchy 'st="$HOME/.local/state/omarchy/current"
case "$1 $2" in
  "theme set") mkdir -p "$st"; echo "$3" >"$st/theme.name" ;;
  "font current") cat "$HOME/.fakefont" 2>/dev/null ;;
  "font set") echo "$3" >"$HOME/.fakefont" ;;
esac'
stub omarchy-shell
stub omarchy-toggle-bar '[[ $1 == off ]] && rm -f "$HOME/.local/state/omarchy/toggles/bar-off"; exit 0'
# hyprsunset as a file: its temperature in ~/sunset-temp, "running" while ~/sunset-running exists.
stub hyprctl '[[ $1 == hyprsunset && $2 == temperature ]] || exit 0
if [[ -n ${3:-} ]]; then echo "$3" >"$HOME/sunset-temp"; echo ok; else cat "$HOME/sunset-temp" 2>/dev/null || echo 6500; fi'
stub pgrep '[[ $* == "-x hyprsunset" && -f $HOME/sunset-running ]]'
stub uwsm-app 'touch "$HOME/sunset-running"'
stub fc-cache
stub notify-send
# Default apps in the fake home's ~/.config/mimeapps.list (one [Default Applications] section).
stub xdg-mime 'f="$HOME/.config/mimeapps.list"
case "$1" in
  query) [[ $2 == default ]] && sed -n "s|^$3=||p" "$f" 2>/dev/null | head -n 1 ;;
  default) mkdir -p "${f%/*}"; { grep -qx "\[Default Applications\]" "$f" 2>/dev/null || echo "[Default Applications]"; grep -v "^$3=" "$f" 2>/dev/null; echo "$3=$2"; } >"$f.new"; mv "$f.new" "$f" ;;
esac; exit 0'
stub tailscale 'exit 1'
stub sudo 'exit 1'
stub pacman 'exit 1'
stub mise "[[ \$1 == where ]] && echo $(printf '%q' "$(dirname "$NODE_BIN")")"
stub systemctl '[[ $* == *is-active* ]] && exit 1; exit 0'
# Fonts: a copy of the pinned files (install-fonts.sh checks their SHA-256), never a download in the test.
stub curl "out=''; url=''
while ((\$#)); do case \$1 in -o) out=\$2; shift ;; http*) url=\$1 ;; esac; shift; done
case \$url in *VT323*) cp $T/fonts/VT323-Regular.ttf \"\$out\" ;; *Antonio*) cp $T/fonts/Antonio-Variable.ttf \"\$out\" ;; *) exit 22 ;; esac"
for d in "$HOME/.local/share/fonts/phosphor-os" "$HOME/.local/share/fonts/retro-claude"; do
  [[ -f $d/VT323-Regular.ttf ]] && cp "$d"/*.ttf "$T/fonts/" && break
done
if [[ ! -f $T/fonts/VT323-Regular.ttf ]]; then # not installed here: get them once (install-fonts.sh checks them)
  urls=$(sed -n 's/^  "\([^|]*\)|\([^|]*\)|.*/\1 \2/p' "$R/os/omarchy/install-fonts.sh")
  while read -r name url; do command curl -fsSL -o "$T/fonts/$name" "$url"; done <<<"$urls"
fi

# tenv NAME cmd...: run cmd with the fake home $T/NAME and the stand-ins first on PATH
tenv() {
  local h=$T/$1; shift
  env -u HYPRLAND_INSTANCE_SIGNATURE -u WAYLAND_DISPLAY -u XDG_CONFIG_HOME -u PHOSPHOR_NODE -u RETRO_NODE \
    -u PHOSPHOR_SHELL_DATA -u RETRO_SHELL_DATA -u PHOSPHOR_VOICE_DIR -u RETRO_VOICE_DIR \
    HOME="$h" XDG_DATA_HOME="$h/.local/share" XDG_STATE_HOME="$h/.local/state" XDG_CACHE_HOME="$h/.cache" \
    XDG_RUNTIME_DIR="$h/run" STUBLOG="$h/stub.log" PATH="$T/stubs:$PATH" "$@"
}
q() { tenv "$@" >/dev/null 2>&1; }
# Answers every question with y (setup-linux.sh asks on the terminal, so give it one).
# A fixed number of answers: an endless `yes` would pile up in script's buffer.
yes_tty() { local name=$1; shift; printf 'y\n%.0s' {1..20} | tenv "$name" timeout 300 script -qec "$(printf '%q ' "$@")" /dev/null >/dev/null 2>&1; }
# snap NAME [prune...]: every path, link and file hash in the fake home, to compare before and after
snap() {
  local h=$T/$1; shift
  local prune=(-path ./stub.log -o -path ./.cache)
  for p in "$@"; do prune+=(-o -path "./$p"); done
  (cd "$h" && find . \( "${prune[@]}" \) -prune -o -printf '%y %p %l\n' | sort &&
    find . \( "${prune[@]}" \) -prune -o -type f -exec sha256sum {} + | sort -k2)
}
mkhome() { # NAME: an Omarchy user before the pack
  local h=$T/$1
  rm -rf "$h"
  mkdir -p "$h/.config/omarchy/bar/modules" "$h/.config/omarchy/themes" "$h/.local/share" "$h/.local/state/omarchy/current" "$h/run"
  cp "$OMARCHY_JSON" "$h/.config/omarchy/shell.json"
  chmod 600 "$h/.config/omarchy/shell.json"
  printf '[font]\nbase-size = 12\n' >"$h/.config/omarchy/shell.toml"
  cp "$R/os/omarchy/bar/taskbar.qml" "$h/.config/omarchy/bar/modules/taskbar.qml"
  mkdir -p "$h/.config/omarchy/extensions" # Omarchy's menu file: comments and an empty object
  printf '{\n  // Extend the menu with JSONC.\n  // "personal.notes": {"icon":"","label":"Notes"},\n}\n' >"$h/.config/omarchy/extensions/omarchy-menu.jsonc"
  echo tokyo-night >"$h/.local/state/omarchy/current/theme.name"
  echo "JetBrainsMono Nerd Font" >"$h/.fakefont"
}
# The pack as it was before the rename: the fixture scripts, with today's themes and bar.
OLDPACK=$T/oldpack
mkdir -p "$OLDPACK"
cp "$OLD/desktop.sh" "$OLD/install-fonts.sh" "$OLDPACK/"
cp -r "$OLD/screensaver" "$OLDPACK/screensaver"
ln -s "$R/os/omarchy/themes" "$OLDPACK/themes"
ln -s "$R/os/omarchy/bar" "$OLDPACK/bar"

echo "== A: user files exist, full cycle"
mkhome A; snap A >"$T/A.before"
tenv A bash "$D" --dry-run >/dev/null; snap A >"$T/A.x"; check "dry-run changes nothing" cmp -s "$T/A.before" "$T/A.x"
q A bash "$D"; snap A >"$T/A.r1"
h=$T/A/.config/omarchy
check "json keys set" grep -q '"position": "bottom"' "$h/shell.json"
check "idle lock set" grep -q '"lock": 2000000' "$h/shell.json"
check "taskbar symlink" test "$(readlink "$h/bar/modules/taskbar.qml")" == "$R/os/omarchy/bar/taskbar.qml"
check "screensaver plugin copied, with the built page" svsame "$h/plugins/phosphor-os.screensaver"
check "Omarchy's own screensaver never starts (idle.screensaver like idle.lock)" jq -e '.idle.screensaver==2000000' "$h/shell.json"
check "menu: Screensaver starts ours, file still has its comments" bash -c "grep -q 'omarchy-shell phosphor-os.screensaver show\"}.*phosphor-os:menu' '$h/extensions/omarchy-menu.jsonc' && grep -q 'Extend the menu' '$h/extensions/omarchy-menu.jsonc'"
check "launcher: syntax, and it waits for the page folder" bash -c "bash -n '$SV/launch.sh' && grep -q 'page/saver.html' '$SV/launch.sh'"
check "screensaver in plugins[]" jq -e '[.plugins[]|select(.id=="phosphor-os.screensaver")]|length==1' "$h/shell.json"
check "notifications plugin copied" diff -r "$NF" "$h/plugins/phosphor-os.notifications"
check "notifications replace the built-in, counter last in the bar" jq -e '([.plugins[]|select(.id=="phosphor-os.notifications")]|length==1) and .disabledPlugins==["omarchy.notifications"] and .cloneSourceRestores==["phosphor-os.notifications"] and .bar.layout.right[-1].id=="phosphor-os.notifications"' "$h/shell.json"
check "clock plugin copied" diff -r "$CK" "$h/plugins/phosphor-os.clock"
check "clock and indicators are one widget in the clock's place" jq -e '[.bar.layout[][]|.id]|(index("phosphor-os.clock")!=null) and (index("omarchy.clock")==null) and (index("omarchy.indicators")==null)' "$h/shell.json"
check "clock clone gets the indicator services; inactive ones never pop out in the row" bash -c "jq -e '.omarchy.clonedFrom==\"omarchy.indicators\"' '$CK/manifest.json' >/dev/null && grep -q 'revealInactiveIndicators: alwaysShowIndicators\$' '$CK/Indicators.qml'"
check "clock popup: our copy of the calendar, marked; the widget opens it, the IPC target stays" bash -c "test -f '$CK/Panel.qml' && test -f '$CK/Model.js' && test -f '$CK/Agenda.js' && (( \$(grep -c 'Phosphor-OS' '$CK/Panel.qml') >= 8 )) && grep -q 'Qt.resolvedUrl(\"Clock.qml\")' '$CK/BarWidget.qml' && grep -q 'target: \"omarchy.clock\"' '$CK/Clock.qml' && grep -q 'Qt.resolvedUrl(\"Panel.qml\")' '$CK/Clock.qml'"
check "clock popup: event list logic (node)" node "$R/tests/clock-agenda.mjs"
check "clone routes the built-in id" jq -e '.omarchy.clonedFrom=="omarchy.notifications" and (.kinds|index("service")) and (.kinds|index("bar-widget"))' "$NF/manifest.json"
check "every change to Omarchy's copy is marked" bash -c "(( \$(grep -c Phosphor-OS '$NF/Service.qml') >= 10 )) && ! grep -q 'Liberation Sans' '$NF/components/NotificationCard.qml'"
check "a sender closing a notification takes its waiting row out" bash -c "grep -q 'service.senderClosed(' '$NF/Service.qml' && grep -q 'function senderClosed' '$NF/Service.qml'"
check "an updated waiting notification pops up again" grep -q 'onTuckedChanged' "$NF/Service.qml"
if command -v omarchy-plugin-validate >/dev/null; then
  check "omarchy plugin validate" omarchy-plugin-validate "$h/plugins/phosphor-os.screensaver"
  check "omarchy plugin validate (notifications)" omarchy-plugin-validate "$h/plugins/phosphor-os.notifications"
  check "omarchy plugin validate (clock)" omarchy-plugin-validate "$h/plugins/phosphor-os.clock"
fi
check "notes under the new name" test -f "$T/A/.local/state/PhosphorOS/desktop.state"
check "night light timer installed and started" bash -c "diff -q '$R/os/omarchy/nightlight/phosphor-os-nightlight.timer' '$T/A/.config/systemd/user/phosphor-os-nightlight.timer' && diff -q '$R/os/omarchy/nightlight/phosphor-os-nightlight.service' '$T/A/.config/systemd/user/phosphor-os-nightlight.service' && grep -q 'systemctl --user enable --now phosphor-os-nightlight.timer' '$T/A/stub.log'"
check "the timer runs the script in the clock plugin" bash -c "grep -qx 'ExecStart=%h/.config/omarchy/plugins/phosphor-os.clock/phosphor-nightlight tick' '$R/os/omarchy/nightlight/phosphor-os-nightlight.service' && test -x '$h/plugins/phosphor-os.clock/phosphor-nightlight'"
rm -f "$T/A/stub.log"; q A bash "$D"; snap A >"$T/A.r2"; check "run 2 changes no file" cmp -s "$T/A.r1" "$T/A.r2"
check "run 2 called no setter" bash -c "! grep -v -e 'font current' -e 'xdg-mime query' '$T/A/stub.log'"
tenv A bash "$D" --undo --dry-run >/dev/null; snap A >"$T/A.x"; check "undo dry-run changes nothing" cmp -s "$T/A.r2" "$T/A.x"
q A bash "$D" --undo; snap A >"$T/A.u"; check "undo: byte-for-byte as before" cmp -s "$T/A.before" "$T/A.u"
check "undo stopped the night light timer" grep -q 'systemctl --user disable --now phosphor-os-nightlight.timer' "$T/A/stub.log"

echo "== B: no shell.json, no shell.toml, no bar folder"
mkhome B; rm -rf "$T/B/.config/omarchy/shell.json" "$T/B/.config/omarchy/shell.toml" "$T/B/.config/omarchy/bar"
snap B >"$T/B.before"
q B bash "$D"
check "files created" test -f "$T/B/.config/omarchy/shell.json" -a "$(cat "$T/B/.config/omarchy/shell.toml")" == $'[font]\nbase-size = 16'
check "left order" jq -e '.bar.layout.left|map(.id)==["omarchy.menu","omarchy.workspaces","omarchy.spacer","taskbar"]' "$T/B/.config/omarchy/shell.json"
check "clock bottom right, 12-hour and the date, then the counter" jq -e '(.bar.layout.center|length)==0 and (.bar.layout.right[-3:]|map(.id))==["omarchy.weather","phosphor-os.clock","phosphor-os.notifications"] and .bar.layout.right[-2].format=="dddd h:mm AP MM/dd/yy"' "$T/B/.config/omarchy/shell.json"
snap B >"$T/B.r1"; q B bash "$D"; snap B >"$T/B.r2"; check "run 2 no-op" cmp -s "$T/B.r1" "$T/B.r2"
q B bash "$D" --undo; snap B >"$T/B.u"; check "undo: as before" cmp -s "$T/B.before" "$T/B.u"

echo "== C: files changed after setup (jq -S, like omarchy bar), plus a foreign lcars theme"
mkhome C; h=$T/C/.config/omarchy
jq -S . "$h/shell.json" >"$h/t" && cat "$h/t" >"$h/shell.json" && rm "$h/t" # as if Omarchy wrote it once
printf '[bar]\nsize-horizontal = 30\n\n[font]\nbase-size = 12 # mine\nother = 1\n' >"$h/shell.toml"
mkdir -p "$h/themes/lcars" && echo foreign >"$h/themes/lcars/colors.toml"
cp "$h/shell.json" "$T/C.json0"; cp "$h/shell.toml" "$T/C.toml0"
q C bash "$D" --theme lcars
check "theme lcars on" test "$(cat "$T/C/.local/state/omarchy/current/theme.name")" == lcars
check "pack lcars copied" diff -rq "$R/os/omarchy/themes/lcars" "$h/themes/lcars"
jq -S '(.bar.layout[][] | select(.id=="phosphor-os.clock")).format="HH:mm" | .bar.transparent=true' "$h/shell.json" >"$h/t" && cat "$h/t" >"$h/shell.json" && rm "$h/t"
printf 'extra = 2\n' >>"$h/shell.toml"
q C bash "$D" --undo
jq -S '.bar.layout.center[1].format="HH:mm" | .bar.transparent=true' "$T/C.json0" >"$T/C.json.want"
check "json: only our keys put back, user change kept" cmp -s "$T/C.json.want" "$h/shell.json"
{ cat "$T/C.toml0"; printf 'extra = 2\n'; } | sed 's/^base-size = 12 # mine$/base-size = 12/' >"$T/C.toml.want"
check "toml: our key put back, user line kept" cmp -s "$T/C.toml.want" "$h/shell.toml"
check "foreign lcars theme restored" test "$(cat "$h/themes/lcars/colors.toml")" == foreign
check "theme back to tokyo-night" test "$(cat "$T/C/.local/state/omarchy/current/theme.name")" == tokyo-night
check "notes gone; pre-setup copies of the two changed files kept" \
  test ! -e "$T/C/.local/state/PhosphorOS/desktop.state" -a "$(ls "$T/C/.local/state/PhosphorOS/desktop-backup")" == $'shell.json\nshell.toml'

echo "== D: amber, then green, then undo"
mkhome D; snap D >"$T/D.before"
q D bash "$D"; q D bash "$D" --theme retro-green
check "switched to green" test "$(cat "$T/D/.local/state/omarchy/current/theme.name")" == retro-green
q D bash "$D" --undo; snap D >"$T/D.u"; check "undo: as before (both theme folders gone, tokyo-night back)" cmp -s "$T/D.before" "$T/D.u"

echo "== E: user picks another theme and font after setup: undo leaves them"
mkhome E; q E bash "$D"
echo catppuccin >"$T/E/.local/state/omarchy/current/theme.name"; echo "Fira Mono" >"$T/E/.fakefont"; rm -f "$T/E/stub.log"
q E bash "$D" --undo
check "undo did not touch theme or font" bash -c "! grep -q set '$T/E/stub.log'"

echo "== F: bad option, bad theme"
if tenv A bash "$D" --theme nope >/dev/null 2>&1; then bad "bad theme stops"; else ok "bad theme stops"; fi
check "bad option stops" bash -c "bash '$D' --bogus 2>&1 | grep -q 'Unknown option'"

echo "== G: screensaver: a foreign plugin folder of the same name, plugins dir that Omarchy made, a pack update"
mkhome G; h=$T/G/.config/omarchy; mkdir -p "$h/plugins/phosphor-os.screensaver" "$h/plugins/acme.other"
echo mine >"$h/plugins/phosphor-os.screensaver/manifest.json"; echo other >"$h/plugins/acme.other/manifest.json"
mkdir -p "$h/plugins/phosphor-os.notifications"; echo minenotif >"$h/plugins/phosphor-os.notifications/manifest.json"
snap G >"$T/G.before"
tenv G bash "$D" --dry-run >"$T/G.dry"; snap G >"$T/G.x"; check "dry-run changes nothing" cmp -s "$T/G.before" "$T/G.x"
check "dry-run shows the copy and the plugins[] line" bash -c "grep -q 'cp -r .*screensaver' '$T/G.dry' && grep -q 'phosphor-os.screensaver' '$T/G.dry'"
q G bash "$D"
bk=$T/G/.local/state/PhosphorOS/desktop-backup/phosphor-os.screensaver/manifest.json
check "foreign folder backed up, ours in place" bash -c "$(declare -f svsame); SV='$SV'; PAGE='$PAGE'; svsame '$h/plugins/phosphor-os.screensaver' >/dev/null && [[ \$(cat '$bk') == mine ]]"
echo "// old" >>"$h/plugins/phosphor-os.screensaver/Service.qml" # installed copy differs from the pack (an update)
q G bash "$D"
check "update: pack copy put in, foreign backup untouched" bash -c "$(declare -f svsame); SV='$SV'; PAGE='$PAGE'; svsame '$h/plugins/phosphor-os.screensaver' >/dev/null && [[ \$(cat '$bk') == mine ]]"
check "foreign notifications folder backed up, ours in place" bash -c "diff -r '$NF' '$h/plugins/phosphor-os.notifications' >/dev/null && [[ \$(cat '${bk%/phosphor-os.screensaver/*}/phosphor-os.notifications/manifest.json') == minenotif ]]"
q G bash "$D" --undo; snap G >"$T/G.u"; check "undo: foreign folder back, plugins dir kept, byte-for-byte" cmp -s "$T/G.before" "$T/G.u"

echo "== H: plugins[] has a user plugin; user edits shell.json after setup"
mkhome H; h=$T/H/.config/omarchy
jq -S '.plugins=[{"id":"acme.weather"}]' "$h/shell.json" >"$h/t" && cat "$h/t" >"$h/shell.json" && rm "$h/t"; cp "$h/shell.json" "$T/H.json0"
q H bash "$D"
check "appended after the user's plugin" jq -e '.plugins|map(.id)==["acme.weather","phosphor-os.screensaver","phosphor-os.notifications"]' "$h/shell.json"
jq -S '.idle.screensaver=420' "$h/shell.json" >"$h/t" && cat "$h/t" >"$h/shell.json" && rm "$h/t"
q H bash "$D" --undo
check "undo: our entry out, user plugin and change kept" bash -c "jq -S '.idle.screensaver=420' '$T/H.json0' | cmp -s - '$h/shell.json'"

echo "== I: upgrade: the pack from before the rename ran first, then this one, then undo"
check "fixture is the old pack" grep -q 'retro-claude.screensaver' "$OLDPACK/desktop.sh"
mkhome I; h=$T/I/.config/omarchy; snap I >"$T/I.before"
q I bash "$OLDPACK/desktop.sh"
check "old pack: old plugin, old notes, old fonts folder" test -d "$h/plugins/retro-claude.screensaver" -a -f "$T/I/.local/state/RetroClaude/desktop.state" -a -d "$T/I/.local/share/fonts/retro-claude"
rm -f "$T/I/stub.log"; q I bash "$D"
check "upgrade: new plugin in, old one out" bash -c "$(declare -f svsame); SV='$SV'; PAGE='$PAGE'; svsame '$h/plugins/phosphor-os.screensaver' >/dev/null && [[ ! -e '$h/plugins/retro-claude.screensaver' ]]"
check "upgrade: plugins[] has only the new ids" jq -e '.plugins|map(.id)==["phosphor-os.screensaver","phosphor-os.notifications"]' "$h/shell.json"
check "upgrade: fonts folder moved, not downloaded" bash -c "[[ -d '$T/I/.local/share/fonts/phosphor-os' && ! -e '$T/I/.local/share/fonts/retro-claude' ]] && ! grep -q curl '$T/I/stub.log'"
check "upgrade: keeps using the old notes folder" test -f "$T/I/.local/state/RetroClaude/desktop.state" -a ! -e "$T/I/.local/state/PhosphorOS"
snap I >"$T/I.r1"; q I bash "$D"; snap I >"$T/I.r2"; check "upgrade: run 2 no-op" cmp -s "$T/I.r1" "$T/I.r2"
q I bash "$D" --undo; snap I >"$T/I.u"; check "upgrade undo: byte-for-byte as before" cmp -s "$T/I.before" "$T/I.u"

echo "== J: undo right after the old pack (no new run in between)"
mkhome J; snap J >"$T/J.before"
q J bash "$OLDPACK/desktop.sh"; q J bash "$D" --undo; snap J >"$T/J.u"
check "undo of an old-name install: byte-for-byte as before" cmp -s "$T/J.before" "$T/J.u"

echo "== N: night light schedule (phosphor-nightlight with a fake clock; hyprsunset is a stand-in)"
mkhome N; h=$T/N
NL=$CK/phosphor-nightlight
at() { TZ=UTC date -d "2026-10-13 $1" +%s; } # a fake clock: seconds at HH:MM on a fixed day (UTC)
nl() { tenv N env TZ=UTC HYPRLAND_INSTANCE_SIGNATURE="${SIG:-s1}" bash "$NL" "$@"; }
temp() { cat "$h/sunset-temp" 2>/dev/null; }
check "defaults: 4000 K, no schedule" jq -e '.warmth==4000 and .schedule=="off"' <<<"$(nl status)"
nl set warmth=3300 >/dev/null 2>&1
check "warmth saved in ~/.config/phosphor-os/nightlight.json" jq -e '.warmth==3300' "$h/.config/phosphor-os/nightlight.json"
nl set warmth=9000 >/dev/null 2>&1; w9=$(jq .warmth "$h/.config/phosphor-os/nightlight.json")
nl set warmth=3300 >/dev/null 2>&1
if nl set warmth=hot >/dev/null 2>&1 || nl set from=25:00 >/dev/null 2>&1; then bad "bad values refused"; else ok "bad values refused"; fi
check "warmth capped below Omarchy's off point (6000)" test "$w9" == 5900
nl set --now "$(at 22:00)" schedule=fixed from=21:00 to=07:00 >/dev/null 2>&1
check "fixed 21:00-07:00, set at 22:00: on at the chosen warmth (hyprsunset started)" bash -c "[[ \$(cat '$h/sunset-temp') == 3300 && -f '$h/sunset-running' ]]"
echo 6500 >"$h/sunset-temp" # the owner switches it off by hand
nl tick --now "$(at 23:00)"; check "a manual off sticks until the next edge" test "$(temp)" == 6500
nl tick --now "$(at 23:59)"; check "still off a while later" test "$(temp)" == 6500
echo 4000 >"$h/sunset-temp"; nl tick --now "$(at 07:00)"
check "edge at 07:00: off" bash -c "[[ \$(cat '$h/sunset-temp') == 6500 && \$(sed -n 2p '$h/.local/state/phosphor-os/nightlight-schedule') == off ]]"
echo 4000 >"$h/sunset-temp"; nl tick --now "$(at 12:00)"; check "a manual on in the day sticks" test "$(temp)" == 4000
nl tick --now "$(at 20:59)"; check "still on at 20:59" test "$(temp)" == 4000
echo 6500 >"$h/sunset-temp"; nl tick --now "$(at 21:00)"; check "edge at 21:00: on at the warmth" test "$(temp)" == 3300
echo 6500 >"$h/sunset-temp"; SIG=s2 nl tick --now "$(at 21:30)"; check "new login (Hyprland session): applied once" test "$(temp)" == 3300
echo 6500 >"$h/sunset-temp"; SIG=s2 nl tick --now "$(at 21:31)"; check "... and only once" test "$(temp)" == 6500
rm -f "$h/sunset-running" "$h/sunset-temp" "$h/stub.log"; nl tick --now "$(at 07:00)"
check "edge to off with hyprsunset not running: nothing started" bash -c "[[ ! -e '$h/sunset-running' ]] && ! grep -q 'hyprsunset temperature 6500' '$h/stub.log'"
nl set --now "$(at 03:00)" from=09:00 to=17:00 >/dev/null 2>&1; nl tick --now "$(at 12:00)"
check "a day window (09:00-17:00): on at noon" test "$(temp)" == 3300
nl set --now "$(at 03:00)" from=21:00 to=07:00 >/dev/null 2>&1
rm -f "$h/sunset-temp" "$h/stub.log"; tenv N env TZ=UTC bash "$NL" tick --now "$(at 22:00)"
check "no Hyprland session: does nothing" bash -c "! grep -qs hyprsunset '$h/stub.log'"
mkdir -p "$h/.local/state/omarchy/settings"
echo '{"name":"Nowhere"}' >"$h/.local/state/omarchy/settings/weather.json"
rm -f "$h/stub.log"; nl set --now "$(at 22:00)" schedule=sun >/dev/null 2>&1
check "sun without coordinates: says so" jq -e '.coords==false and .place=="Nowhere"' <<<"$(nl status)"
check "sun without coordinates: switches nothing" bash -c "! grep -qs 'hyprsunset temperature [0-9]' '$h/stub.log'"
echo '{"name":"Equator","latitude":0,"longitude":0}' >"$h/.local/state/omarchy/settings/weather.json"
check "sun times worked out locally (equator: ~06:00 and ~18:00 UTC)" jq -e '(.sunrise|test("^0(5:[3-5]|6:[0-2])")) and (.sunset|test("^1(7:[3-5]|8:[0-2])"))' <<<"$(nl status --now "$(at 12:00)")"
nl tick --now "$(at 12:00)"; check "sun: off at noon" test "$(temp)" == 6500
nl tick --now "$(at 19:00)"; check "sun: on after sunset" test "$(temp)" == 3300
echo '{"name":"North","latitude":69.65,"longitude":18.96}' >"$h/.local/state/omarchy/settings/weather.json"
check "polar night: on all day" jq -e '.allday=="night" and .scheduled=="on"' <<<"$(nl status --now "$(TZ=UTC date -d '2026-12-21 12:00' +%s)")"
nl set schedule=off >/dev/null 2>&1
check "schedule off: its state file goes" test ! -e "$h/.local/state/phosphor-os/nightlight-schedule"

echo "== V: DICTATE in any app (phosphor-dictate + its live client; the mic, the server, the clipboard and the keys are stand-ins)"
mkhome V; h=$T/V
DT=$CK/phosphor-dictate
APP=$h/app; mkdir -p "$APP" "$T/vstubs" "$h/.config/phosphor-os"
ln -s "$R/node_modules" "$APP/node_modules"; cp "$R/package.json" "$APP/" # the live client takes ws from the app
ln -s "$R/shared" "$APP/shared" # and the shared rules (shared/dictate.mjs)
# The mic: raw audio to stdout until stopped (as pw-record - does).
printf '#!/bin/bash\ntrap "exit 0" INT TERM\nwhile :; do head -c 3200 /dev/zero; sleep 0.1; done\n' >"$T/vstubs/pw-record"
# The clipboard: a file. wl-copy notes its flags in clip.meta; wl-paste lists the types it was given.
cat >"$T/vstubs/wl-copy" <<'STUB'
#!/bin/bash
echo "wl-copy $*" >>"$HOME/clip.log"
[[ $1 == --clear ]] && { rm -f "$HOME/clip" "$HOME/clip.meta"; exit 0; }
cat >"$HOME/clip"; printf '%s\n' "$*" >"$HOME/clip.meta"
STUB
cat >"$T/vstubs/wl-paste" <<'STUB'
#!/bin/bash
[[ -f $HOME/clip ]] || exit 1
if [[ $1 == --list-types ]]; then
  grep -q -- '--type image/png' "$HOME/clip.meta" && echo image/png || echo 'text/plain;charset=utf-8'
  grep -q -- --sensitive "$HOME/clip.meta" && echo x-kde-passwordManagerHint
  exit 0
fi
cat "$HOME/clip"
STUB
# Hyprland: the focused window from ~/window.json; a key going down "pastes" what the clipboard holds then.
cat >"$T/vstubs/hyprctl" <<'STUB'
#!/bin/bash
case $1 in
  activewindow) echo asked >>"$HOME/aw.log"; cat "$HOME/window.json" 2>/dev/null || echo '{}' ;;
  dispatch)
    echo "$2" >>"$HOME/keys.log"
    [[ $2 == *'state = "down"'* ]] && cat "$HOME/clip" >>"$HOME/typed"
    echo ok ;;
esac
STUB
printf '#!/bin/bash\necho "wtype $*" >>"$HOME/keys.log"\n' >"$T/vstubs/wtype"
# Login and warm-up (bash side): login writes the cookie; FAKE_DOWN=1: nothing listens.
cat >"$T/vstubs/curl" <<'STUB'
#!/bin/bash
echo "curl $*" >>"$STUBLOG"
[[ -n ${FAKE_DOWN:-} ]] && exit 7
jar_out='' url=''
while (($#)); do case $1 in -c) jar_out=$2; shift ;; http*) url=$1 ;; esac; shift; done
case $url in
  */login) cat >/dev/null; printf '#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\trcs\t1.x\n' >"$jar_out" ;;
  */api/voice/warm) printf 202 ;;
esac
STUB
chmod +x "$T/vstubs"/*
# The speech server: /ws/voice (needs the cookie; a partial per audio frame, on "end" one final and done),
# /api/transcribe (the one-shot fallback) and /api/voice/cleanup. In its folder: NOWS=1 refuses the socket,
# NOCLEAN=1 answers the clean-up with 404 (a server without it).
cat >"$T/fakevoice.mjs" <<'JS'
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(process.argv[2] + '/package.json')('ws');
const dir = process.argv[3];
const wss = new WebSocketServer({ noServer: true });
const srv = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const ok = (req.headers.cookie ?? '').includes('rcs=1.x');
  const send = (code, data) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  if (!ok) return send(401, { error: 'login needed' });
  if (req.url === '/api/voice/cleanup') {
    if (existsSync(`${dir}/NOCLEAN`)) return send(404, { error: 'not found' });
    const { text, style } = JSON.parse(body);
    return send(200, { text: `${style}: ${text.replace(/\.$/, '')}!`, by: 'test' });
  }
  send(200, { text: 'from one shot.', ms: 1, seconds: 1 });
});
srv.on('upgrade', (req, sock, head) => {
  if (existsSync(`${dir}/NOWS`) || !(req.headers.cookie ?? '').includes('rcs=1.x')) return sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.send(JSON.stringify({ t: 'ready' }));
    ws.on('message', (d, bin) => {
      if (bin) return ws.send(JSON.stringify({ t: 'partial', text: 'hello' }));
      ws.send(JSON.stringify({ t: 'final', text: 'hello there.', end: 1 }));
      ws.send(JSON.stringify({ t: 'done', end: 1 }));
    });
  });
});
srv.listen(0, '127.0.0.1', () => console.log(srv.address().port));
JS
node "$T/fakevoice.mjs" "$R" "$T" >"$T/fakevoice.port" 2>/dev/null &
FAKEV=$!
for _ in $(seq 50); do [[ -s $T/fakevoice.port ]] && break; sleep 0.1; done
printf 'PHOSPHOR_PASSWORD="s3cret pw"\nPHOSPHOR_PORT=%s\n' "$(cat "$T/fakevoice.port")" >"$APP/.env"
dt() { tenv V env PATH="$T/vstubs:$T/stubs:$PATH" HYPRLAND_INSTANCE_SIGNATURE=test PHOSPHOR_OS_DIR="$APP" PHOSPHOR_NODE="$(command -v node)" bash "$DT" "$@"; }
dstate() { head -n1 "$h/.local/state/phosphor-os/dictate" 2>/dev/null; }
untilidle() { for _ in $(seq 80); do [[ $(dstate) == idle ]] && return 0; sleep 0.1; done; return 1; }
window() { printf '%s' "$1" >"$h/window.json"; }
fresh() { rm -f "$h/typed" "$h/keys.log" "$h/clip.log"; printf 'old words' >"$h/clip"; printf -- '--type text/plain\n' >"$h/clip.meta"; }
settings() { printf '{ "cleanup": %s }\n' "$1" >"$h/.config/phosphor-os/dictate.json"; }
settings false; window '{"address":"0x1","class":"discord","initialClass":"discord","tags":[]}'; fresh
dt toggle; sleep 0.8
check "press 1: listening, the take runs" bash -c "[[ \$(head -n1 '$h/.local/state/phosphor-os/dictate') == recording ]] && kill -0 \$(cat '$h/run/phosphor-dictate/take.pid')"
check "the words heard so far, for the overlay" grep -q '^hello$' "$h/.local/state/phosphor-os/dictate"
take=$(cat "$h/run/phosphor-dictate/take.pid")
dt toggle; untilidle; sleep 0.3
check "press 2: pasted into the app (Ctrl+V), capital and a space after" bash -c "[[ \$(cat '$h/typed') == 'Hello there. ' ]] && grep -q 'mods = \"CTRL\", key = \"v\", state = \"down\"' '$h/keys.log' && grep -q 'state = \"up\"' '$h/keys.log'"
check "the words went on the clipboard marked sensitive (not in the clipboard history)" grep -q -- '--sensitive --type text/plain;charset=utf-8' "$h/clip.log"
check "the old clipboard is back" test "$(cat "$h/clip")" == "old words"
check "press 2: idle, the take gone" bash -c "[[ \$(cat '$h/.local/state/phosphor-os/dictate') == idle ]] && ! kill -0 $take 2>/dev/null"
check "logged in, with the password from .env" grep -q '/login' "$h/stub.log"
check "the password never on a command line" bash -c "! grep -q 's3cret' '$h/stub.log'"
check "the cookie jar is private" test "$(stat -c %a "$h/run/phosphor-dictate/cookie")" == 600
check "curl gives up on a hung server (login and warm-up: -m 5)" bash -c "grep '/login' '$h/stub.log' | grep -q -- ' -m 5 ' && grep '/api/voice/warm' '$h/stub.log' | grep -q -- ' -m 5 '"
window '{"address":"0x2","class":"com.mitchellh.ghostty","initialClass":"com.mitchellh.ghostty","tags":["terminal*"]}'; fresh
dt toggle; sleep 0.8; dt toggle; untilidle
check "a terminal gets Ctrl+Shift+V" bash -c "[[ \$(cat '$h/typed') == 'Hello there. ' ]] && grep -q 'mods = \"CTRL SHIFT\", key = \"v\"' '$h/keys.log'"
window '{"address":"0x1","class":"discord","initialClass":"discord","tags":[]}'; fresh; rm -f "$h/aw.log"
dt toggle; sleep 0.8; dt toggle
for _ in $(seq 50); do [[ -s $h/aw.log ]] && break; sleep 0.02; done # the stop noted the window; the paste comes later
window '{"address":"0x2","class":"com.mitchellh.ghostty","initialClass":"com.mitchellh.ghostty","tags":["terminal*"]}'; untilidle
check "the keyboard went to another window while it worked: no key, the words stay on the clipboard" bash -c "[[ ! -e '$h/keys.log' && \$(cat '$h/clip') == 'Hello there. ' ]]"
window '{}'; fresh; rm -f "$h/stub.log"
dt toggle; sleep 0.8; dt toggle; untilidle
check "no program has the keyboard: no key, the words stay on the clipboard, a note says so" bash -c "[[ ! -e '$h/keys.log' && \$(cat '$h/clip') == 'Hello there. ' ]] && grep -q 'notify-send.*on the clipboard' '$h/stub.log'"
window '{"address":"0x1","class":"discord","tags":[]}'; fresh; printf -- '--sensitive --type text/plain\n' >"$h/clip.meta"
dt toggle; sleep 0.8; dt toggle; untilidle
check "a password manager's clipboard comes back marked sensitive" bash -c "[[ \$(cat '$h/clip') == 'old words' ]] && tail -n1 '$h/clip.log' | grep -q -- --sensitive"
settings true; fresh
dt toggle; sleep 0.8; dt toggle; untilidle
check "CLEAN UP on: the server's tidy words go in (style plain)" test "$(cat "$h/typed" 2>/dev/null)" == "plain: Hello there! "
touch "$T/NOCLEAN"; fresh
dt toggle; sleep 0.8; dt toggle; untilidle
check "CLEAN UP on, the server has none (404): the words as they were" test "$(cat "$h/typed" 2>/dev/null)" == "Hello there. "
rm -f "$T/NOCLEAN"; settings false
touch "$T/NOWS"; fresh
dt toggle; sleep 0.8
check "live socket refused: says the text comes at the end" grep -q 'no live preview' "$h/.local/state/phosphor-os/dictate"
dt toggle; untilidle
check "... and the take still goes in (one shot)" test "$(cat "$h/typed" 2>/dev/null)" == "from one shot. "
rm -f "$T/NOWS"; fresh; rm -f "$h/stub.log"
dt toggle & first=$!; dt toggle; wait "$first"; untilidle
check "two presses at once: one take, started and stopped (none left recording unseen)" bash -c "[[ \$(grep -c '/api/voice/warm' '$h/stub.log') == 1 && \$(cat '$h/typed') == 'Hello there. ' ]]"
rm -f "$h/typed"; dt toggle; sleep 0.5; take=$(cat "$h/run/phosphor-dictate/take.pid"); dt cancel; sleep 0.5
check "cancel: idle, nothing goes in, the take gone" bash -c "[[ \$(head -n1 '$h/.local/state/phosphor-os/dictate') == idle && ! -e '$h/typed' ]] && ! kill -0 $take 2>/dev/null"
rm -f "$h/stub.log"; FAKE_DOWN=1 dt toggle
check "server down: says so, back to idle" bash -c "grep -q 'notify-send.*not answering' '$h/stub.log' && [[ \$(head -n1 '$h/.local/state/phosphor-os/dictate') == idle ]]"
kill "$FAKEV" 2>/dev/null
echo recording >"$h/.local/state/phosphor-os/dictate"; dt reset
check "reset at login: a cut-off take leaves no mic dot" test "$(dstate)" == idle
check "Hyprland: Ctrl+Space dictates, and in Phosphor-OS goes on to the app" bash -c "grep -q 'hl.bind(\"CTRL + SPACE\"' '$R/os/hyprland/phosphor-os.lua' && grep -q 'w.class == \"phosphor-os\"' '$R/os/hyprland/phosphor-os.lua' && grep -q 'dictate .. \" reset\"' '$R/os/hyprland/phosphor-os.lua'"
check "the mic indicator is the pack's (both loaders)" bash -c "grep -q 'indicatorUrl(indicatorSlot.indicatorId)' '$CK/Indicators.qml' && grep -q 'indicators.indicatorUrl(' '$CK/BarWidget.qml' && grep -q 'phosphor-os/dictate' '$CK/Dictation.qml'"
# The key in Hyprland's Lua with a stand-in hl: outside Phosphor-OS it toggles the take; in Phosphor-OS it hands the
# app its own DICTATE key (down, then up from a timer); Ctrl + Space is unbound first so ours wins; Super + H is the
# user's (not bound, not unbound).
cat >"$T/keys.lua" <<'LUA'
phosphor_os_dir = arg[1]
local fns, timers, cmds, keys, unbound, active = {}, {}, {}, {}, {}, "discord"
local any = setmetatable({}, { __index = function() return function() return {} end end })
hl = setmetatable({
  bind = function(k, fn) fns[k] = fn end,
  unbind = function(k) table.insert(unbound, k) end,
  timer = function(fn) table.insert(timers, fn) end,
  dispatch = function(d) if d.exec then table.insert(cmds, d.exec) end end,
  get_active_window = function() return { class = active } end,
  dsp = setmetatable({ exec_cmd = function(c) return { exec = c } end, window = any,
    send_key_state = function(k) table.insert(keys, k.mods .. "+" .. k.key .. ":" .. k.state) return {} end }, { __index = function() return function() return {} end end }),
}, { __index = function() return function() end end })
dofile(phosphor_os_dir .. "/os/hyprland/phosphor-os.lua")
local function say(name, ok) print((ok and "ok " or "BAD ") .. name) end
local function has(list, x) for _, v in ipairs(list) do if v == x then return true end end return false end
fns["CTRL + SPACE"]()
say("outside the app: the take is toggled", #cmds == 1 and cmds[1]:match(" toggle$") ~= nil and #timers == 0 and #keys == 0)
cmds = {}; active = "phosphor-os"; fns["CTRL + SPACE"](); table.remove(timers, 1)()
say("in Phosphor-OS: the app's own DICTATE key, down then up", #cmds == 0 and table.concat(keys, " ") == "CTRL+space:down CTRL+space:up")
say("Ctrl + Space is unbound first, so ours wins", has(unbound, "CTRL + SPACE"))
say("Super + H is left alone", fns["SUPER + H"] == nil and not has(unbound, "SUPER + H"))
LUA
if command -v lua >/dev/null; then
  lua "$T/keys.lua" "$R" >"$T/keys.out" 2>&1
  check "Ctrl+Space: toggles the take; in Phosphor-OS goes on to the app; Super+H not touched" bash -c "[[ \$(grep -c '^ok ' '$T/keys.out') == 4 ]]"
else
  echo "SKIP: Ctrl+Space key logic (no lua)"
fi
mkhome W; q W bash "$D"
h=$T/W/.config/omarchy
check "desktop.sh: the indicator's state file exists before the bar starts" test -e "$T/W/.local/state/phosphor-os/dictate"
check "no floating mic: no plugin, no entry in plugins[], no settings file made" bash -c "[[ ! -e '$h/plugins/phosphor-os.dictate' && ! -e '$T/W/.config/phosphor-os' ]] && ! grep -q phosphor-os.dictate '$h/shell.json'"
q W bash "$D" --undo
check "undo: the state file goes" test ! -e "$T/W/.local/state/phosphor-os/dictate"

echo "== X: the pack with the floating mic (until 2026-10-26) ran first, then this one: the mic is taken out; undo after it"
# A copy of the pack folder with that version's desktop.sh and a stand-in plugin folder, next to the built page.
FLOATREPO=$T/floatrepo FLOATPACK=$T/floatrepo/os/omarchy
mkdir -p "$FLOATREPO/os" "$FLOATREPO/web"
cp -r "$R/os/omarchy" "$FLOATPACK" && cp -r "$R/os/mpv" "$FLOATREPO/os/mpv" && ln -s "$R/web/dist" "$FLOATREPO/web/dist"
cp "$FLOAT/desktop.sh" "$FLOATPACK/desktop.sh" && cp -r "$FLOAT/dictate" "$FLOATPACK/dictate"
mkhome X; h=$T/X/.config/omarchy
q X bash "$FLOATPACK/desktop.sh"
check "that version: the plugin, its entry in plugins[] and its settings file are in" bash -c "[[ -d '$h/plugins/phosphor-os.dictate' && -f '$T/X/.config/phosphor-os/dictate.json' ]] && jq -e '[.plugins[]|select(.id==\"phosphor-os.dictate\")]|length==1' '$h/shell.json' >/dev/null"
jq -S '.plugins += [{"id":"acme.weather"}]' "$h/shell.json" >"$h/t" && cat "$h/t" >"$h/shell.json" && rm "$h/t" # a plugin of your own, added since
snap X >"$T/X.old"; tenv X bash "$D" --dry-run >"$T/X.dry" 2>&1; snap X >"$T/X.x"
check "dry-run changes nothing, and shows the mic going" bash -c "cmp -s '$T/X.old' '$T/X.x' && grep -q 'rm -rf .*phosphor-os.dictate' '$T/X.dry' && grep -q 'phosphor-os.dictate' '$T/X.dry'"
q X bash "$D"
check "this version: the plugin folder is gone and its entry too; the others stay" bash -c "[[ ! -e '$h/plugins/phosphor-os.dictate' ]] && jq -e '.plugins|map(.id)==[\"phosphor-os.screensaver\",\"phosphor-os.notifications\",\"acme.weather\"]' '$h/shell.json' >/dev/null"
check "this version: the notes about the mic are gone; CLEAN UP's settings file stays for undo" bash -c "! grep -qE '^(dict_dir|json_dict)=' '$T/X/.local/state/PhosphorOS/desktop.state' && grep -q '^dictate_settings=' '$T/X/.local/state/PhosphorOS/desktop.state' && [[ -f '$T/X/.config/phosphor-os/dictate.json' ]]"
check "this version: the clock plugin is its own" diff -r "$CK" "$h/plugins/phosphor-os.clock"
snap X >"$T/X.r1"; q X bash "$D"; snap X >"$T/X.r2"; check "run 3 changes nothing" cmp -s "$T/X.r1" "$T/X.r2"
mkhome Y; snap Y >"$T/Y.before"
q Y bash "$FLOATPACK/desktop.sh"; q Y bash "$D"; q Y bash "$D" --undo; snap Y >"$T/Y.u"
check "that version, this version, undo: byte-for-byte as before" cmp -s "$T/Y.before" "$T/Y.u"
mkhome Z; snap Z >"$T/Z.before"
q Z bash "$FLOATPACK/desktop.sh"; q Z bash "$D" --undo; snap Z >"$T/Z.u"
check "that version, then undo without a re-run: the mic goes too, byte-for-byte as before" cmp -s "$T/Z.before" "$T/Z.u"

# ------------------------------------------------------------------ an install made under the old name

# oldinstall NAME PROJECT: what the old setup-linux.sh left (look via the old pack, Hyprland line, unit, menu entry)
oldinstall() {
  local n=$1 p=$2 h=$T/$1
  q "$n" bash "$OLDPACK/desktop.sh"
  mkdir -p "$h/.config/hypr" "$h/.config/systemd/user" "$h/.local/share/applications" "$h/.local/share/RetroClaude/shell/electron-44.4.5"
  printf -- '-- Omarchy config\nrequire("default")\n' >"$h/.config/hypr/hyprland.lua"
  cp "$h/.config/hypr/hyprland.lua" "$T/$n.hypr0"
  printf 'retro_claude_dir = "%s"; dofile(retro_claude_dir .. "/os/hyprland/retro-claude.lua") -- retro-claude-desktop (scripts/setup-linux.sh; --undo removes this line)\n' "$p" >>"$h/.config/hypr/hyprland.lua"
  printf '[Unit]\nDescription=Retro Claude app server\n[Service]\nWorkingDirectory=%s\n' "$p" >"$h/.config/systemd/user/retro-claude-server.service"
  printf '[Desktop Entry]\nName=Retro Claude\n' >"$h/.local/share/applications/retro-claude.desktop"
  printf '#!/bin/sh\n' >"$h/.local/share/RetroClaude/shell/electron-44.4.5/electron"
  chmod +x "$h/.local/share/RetroClaude/shell/electron-44.4.5/electron"
  printf 'hypr_line=1\nservice=1\nelectron=1\n' >>"$h/.local/state/RetroClaude/setup-linux.state"
}

echo "== S: setup-linux.sh --undo cleans up an install made under the old name"
mkhome S; oldinstall S "$T/S/retro-claude"; h=$T/S
yes_tty S bash "$R/scripts/setup-linux.sh" --undo
check "old Hyprland line out, rest of hyprland.lua as before" cmp -s "$T/S.hypr0" "$h/.config/hypr/hyprland.lua"
check "old service stopped and removed" bash -c "grep -q 'systemctl --user disable --now retro-claude-server.service' '$h/stub.log' && [[ ! -e '$h/.config/systemd/user/retro-claude-server.service' ]]"
check "old menu entry removed" test ! -e "$h/.local/share/applications/retro-claude.desktop"
check "old plugin out of shell.json and its folder gone" bash -c "! grep -q retro-claude '$h/.config/omarchy/shell.json' && [[ ! -e '$h/.config/omarchy/plugins/retro-claude.screensaver' ]]"
check "Electron in the old folder removed (asked)" test ! -e "$h/.local/share/RetroClaude/shell/electron-44.4.5"
check "notes gone" test ! -e "$h/.local/state/RetroClaude/setup-linux.state" -a ! -e "$h/.local/state/RetroClaude/desktop.state"
check "look back: theme and font as before" bash -c "[[ \$(cat '$h/.local/state/omarchy/current/theme.name') == tokyo-night && \$(cat '$h/.fakefont') == 'JetBrainsMono Nerd Font' ]]"

echo "== L: setup-linux.sh --app-only (dry run): the app's steps, no desktop mode, and later runs remember it"
mkhome L; h=$T/L; mkdir -p "$h/.config/hypr" "$h/ws"; echo '-- hyprland' >"$h/.config/hypr/hyprland.lua"; snap L >"$T/L.before"
tenv L bash "$R/scripts/setup-linux.sh" --dry-run --app-only --workspace "$h/ws" </dev/null >"$T/L.out" 2>&1
check "app only: step 8 is the menu entries" grep -q '8. App menu entries' "$T/L.out"
check "app only: no desktop mode, no look, no Markdown default" bash -c "! grep -qE 'Desktop mode|hyprland.lua|desktop.sh|xdg-mime' '$T/L.out'"
snap L >"$T/L.after"; check "app only: dry run changes nothing" cmp -s "$T/L.before" "$T/L.after"
mkdir -p "$h/.local/state/PhosphorOS" && echo app_only=1 >"$h/.local/state/PhosphorOS/setup-linux.state"
tenv L bash "$R/scripts/setup-linux.sh" --dry-run --workspace "$h/ws" </dev/null >"$T/L.out2" 2>&1
check "app only remembered: no flag, still no desktop mode" bash -c "grep -q 'App only (from an earlier run)' '$T/L.out2' && ! grep -q 'Desktop mode' '$T/L.out2'"
tenv L bash "$R/scripts/setup-linux.sh" --dry-run --full --workspace "$h/ws" </dev/null >"$T/L.out3" 2>&1
check "--full: desktop mode again" grep -q 'Desktop mode (Hyprland)' "$T/L.out3"

echo "== M: scripts/migrate-from-retro-claude.sh on a fake home"
mkhome M; h=$T/M; NEW=$h/phosphor-os OLDP=$h/retro-claude
rsync -a --exclude .git --exclude node_modules --exclude data --exclude .env --exclude web/dist "$R/" "$NEW/"
ln -s "$R/node_modules" "$NEW/node_modules" # never npm ci here: it would empty the real one through the link
# ... so the copy's lock file is older than the installed packages: the setup then skips npm ci. A lock file newer than
# them (a checkout or revert of package-lock.json) made it run, and it emptied the repo's node_modules.
touch -r "$R/node_modules/.package-lock.json" -d '-1 minute' "$NEW/package-lock.json" || missing "npm ci in $R"
mkdir -p "$NEW/web" && cp -r "$R/web/dist" "$NEW/web/dist"
oldinstall M "$OLDP"
printf '[Default Applications]\ntext/markdown=typora.desktop\ntext/plain=nvim.desktop\n' >"$h/.config/mimeapps.list" # your own pick
mkdir -p "$OLDP/data" "$h/ws"
echo s3cret-key >"$OLDP/data/secret"; echo '[]' >"$OLDP/data/tabs.json"
printf 'RETRO_PASSWORD="old pass"\nRETRO_CWD=%s\nRETRO_PORT=7399\nPHOSPHOR_PORT=7398\n' "$h/ws" >"$OLDP/.env"; chmod 600 "$OLDP/.env"
mkdir -p "$h/.local/share/RetroClaude/shell-data"
bash -c 'exec -a "electron shell/main.mjs" sleep 300' & fake_app=$!
echo "$fake_app" >"$h/.local/share/RetroClaude/shell-data/app.pid"
snap M phosphor-os >"$T/M.before"
# A cgroup namespace: the script refuses to run inside the old server's service (where this test may run).
mig() { tenv M unshare --user --map-current-user --cgroup bash "$NEW/scripts/migrate-from-retro-claude.sh" --from "$OLDP" "$@"; }
mig --dry-run >"$T/M.dry" 2>&1; snap M phosphor-os >"$T/M.x"
check "dry-run changes nothing" cmp -s "$T/M.before" "$T/M.x"
check "dry-run prints no password" bash -c "! grep -q 'old pass' '$T/M.dry'"
check "dry-run shows the moves and the setup" bash -c "grep -q 'mv .*retro-claude/data' '$T/M.dry' && grep -q 'RETRO_PASSWORD -> PHOSPHOR_PASSWORD' '$T/M.dry' && grep -q 'phosphor-os-desktop' '$T/M.dry'"
check "fake old app still running after the dry run" kill -0 "$fake_app"
mig --yes >"$T/M.run1" 2>&1
sleep 0.3
check "old app stopped (by its pid file)" bash -c "! kill -0 $fake_app 2>/dev/null"
wait "$fake_app" 2>/dev/null
check "old service stopped and removed" bash -c "grep -q 'disable --now retro-claude-server.service' '$h/stub.log' && [[ ! -e '$h/.config/systemd/user/retro-claude-server.service' ]]"
check "new service written and started" bash -c "grep -q 'WorkingDirectory=$NEW' '$h/.config/systemd/user/phosphor-os-server.service' && grep -q 'enable --now phosphor-os-server.service' '$h/stub.log'"
check "data/ and .env moved" bash -c "[[ \$(cat '$NEW/data/secret') == s3cret-key && -f '$NEW/.env' && ! -e '$OLDP/data' && ! -e '$OLDP/.env' ]]"
check ".env renamed, values kept, existing PHOSPHOR_PORT wins" bash -c "! grep -q '^RETRO_' '$NEW/.env' && grep -qx 'PHOSPHOR_PASSWORD=\"old pass\"' '$NEW/.env' && grep -qx 'PHOSPHOR_PORT=7398' '$NEW/.env' && [[ \$(grep -c '^PHOSPHOR_PORT=' '$NEW/.env') == 1 && \$(grep -c '^PHOSPHOR_CWD=' '$NEW/.env') == 1 ]]"
check ".env only readable by you" test "$(stat -c %a "$NEW/.env")" == 600
check "per-PC folders moved" bash -c "[[ -x '$h/.local/share/PhosphorOS/shell/electron-44.4.5/electron' && ! -e '$h/.local/share/RetroClaude' && -d '$h/.local/share/fonts/phosphor-os' && ! -e '$h/.local/share/fonts/retro-claude' && -f '$h/.local/state/PhosphorOS/desktop.state' && ! -e '$h/.local/state/RetroClaude' ]]"
check "Hyprland: old line swapped for the new one" bash -c "! grep -q retro-claude '$h/.config/hypr/hyprland.lua' && [[ \$(grep -c 'phosphor-os-desktop' '$h/.config/hypr/hyprland.lua') == 1 ]] && grep -q 'phosphor_os_dir = \"$NEW\"' '$h/.config/hypr/hyprland.lua'"
check "menu entry swapped" bash -c "[[ -f '$h/.local/share/applications/phosphor-os.desktop' && ! -e '$h/.local/share/applications/retro-claude.desktop' ]]"
check "Phosphor Docs menu entry opens DOCS, and a Markdown file in it" bash -c "grep -qx 'Name=Phosphor Docs' '$h/.local/share/applications/phosphor-docs.desktop' && grep -q '^Exec=bash \".*/scripts/phosphor-os.sh\" --docs %f\$' '$h/.local/share/applications/phosphor-docs.desktop' && grep -q '^Keywords=docs;' '$h/.local/share/applications/phosphor-docs.desktop' && grep -qx 'MimeType=text/markdown;text/x-markdown;' '$h/.local/share/applications/phosphor-docs.desktop'"
check "Markdown opens in Phosphor Docs; text/plain untouched" bash -c "grep -qx 'text/markdown=phosphor-docs.desktop' '$h/.config/mimeapps.list' && grep -qx 'text/x-markdown=phosphor-docs.desktop' '$h/.config/mimeapps.list' && grep -qx 'text/plain=nvim.desktop' '$h/.config/mimeapps.list'"
check "screensaver plugin swapped" bash -c "[[ -d '$h/.config/omarchy/plugins/phosphor-os.screensaver' && ! -e '$h/.config/omarchy/plugins/retro-claude.screensaver' ]] && jq -e '.plugins|map(.id)==[\"phosphor-os.screensaver\",\"phosphor-os.notifications\"]' '$h/.config/omarchy/shell.json' >/dev/null"
check "run 1 ends with the setup's Done" grep -q '^== Done' "$T/M.run1"
snap M phosphor-os retro-claude .npm >"$T/M.r1"
mig --yes >"$T/M.run2" 2>&1; snap M phosphor-os retro-claude .npm >"$T/M.r2"
check "run 2 changes nothing" cmp -s "$T/M.r1" "$T/M.r2"
check "run 2 has nothing left to move" bash -c "grep -q 'Nothing runs under the old name' '$T/M.run2' && grep -q 'Nothing to rename' '$T/M.run2'"
yes_tty M bash "$NEW/scripts/setup-linux.sh" --undo
check "undo after the move: Hyprland line out, service, menu entries, plugin gone" bash -c "cmp -s '$T/M.hypr0' '$h/.config/hypr/hyprland.lua' && [[ ! -e '$h/.config/systemd/user/phosphor-os-server.service' && ! -e '$h/.local/share/applications/phosphor-os.desktop' && ! -e '$h/.local/share/applications/phosphor-docs.desktop' && ! -e '$h/.config/omarchy/plugins/phosphor-os.screensaver' && ! -e '$h/.config/omarchy/plugins/phosphor-os.notifications' ]]"
check "undo: Markdown back to your own pick, x-markdown line gone, notes gone" bash -c "grep -qx 'text/markdown=typora.desktop' '$h/.config/mimeapps.list' && ! grep -q phosphor-docs '$h/.config/mimeapps.list' && grep -qx 'text/plain=nvim.desktop' '$h/.config/mimeapps.list' && ! grep -qs mime_was '$h/.local/state/PhosphorOS/setup-linux.state'"
if grep -q retro-claude-server.service /proc/self/cgroup; then # only testable from inside that service
  out="$(tenv M bash "$NEW/scripts/migrate-from-retro-claude.sh" --dry-run 2>&1)"
  check "refuses to run inside the old server's service" grep -q 'would stop itself' <<<"$out"
fi

echo "== O: the page is not built: Omarchy's own screensaver stays untouched"
mkdir -p "$T/nb/os" && cp -r "$R/os/omarchy" "$T/nb/os/omarchy" # a pack folder with no web/dist next to it
mkhome O; h=$T/O/.config/omarchy; snap O >"$T/O.before"
q O bash "$T/nb/os/omarchy/desktop.sh"
check "no plugin, no plugins[] entry, idle.screensaver as it was, menu as it was" bash -c "[[ ! -e '$h/plugins/phosphor-os.screensaver' ]] && jq -e '([.plugins[]|select(.id==\"phosphor-os.screensaver\")]|length==0) and .idle.screensaver==150' '$h/shell.json' >/dev/null && ! grep -q phosphor '$h/extensions/omarchy-menu.jsonc'"
q O bash "$T/nb/os/omarchy/desktop.sh" --undo; snap O >"$T/O.u"; check "undo: byte-for-byte as before" cmp -s "$T/O.before" "$T/O.u"

echo "== P: launch.sh with stand-in browser, hyprctl and omarchy-shell (nothing opens)"
mkhome K; h=$T/K; : >"$h/stub.log"; kd=$h/.config/omarchy/plugins/phosphor-os.screensaver
mkdir -p "$kd" && cp -r "$SV/." "$kd/" && cp -r "$PAGE" "$kd/page"
stub chromium 'sleep 30'
stub omarchy-shell 'echo false'
mkdir -p "$h/.local/state/omarchy/indicators" && touch "$h/.local/state/omarchy/indicators/stay-awake"
tenv K bash "$kd/launch.sh" idle; check "stay awake: no browser started" bash -c "! grep -q '^chromium' '$h/stub.log'"
rm "$h/.local/state/omarchy/indicators/stay-awake"; mkdir -p "$h/.local/state/omarchy/toggles"; touch "$h/.local/state/omarchy/toggles/screensaver-off"
tenv K bash "$kd/launch.sh" idle; check "screensaver-off toggle: no browser started" bash -c "! grep -q '^chromium' '$h/stub.log'"
rm -rf "$kd/page"; if tenv K bash "$kd/launch.sh" force >/dev/null 2>&1; then bad "no page: stops"; else ok "no page: stops"; fi

echo
echo "$PASS passed, $FAIL failed"
((FAIL == 0))
