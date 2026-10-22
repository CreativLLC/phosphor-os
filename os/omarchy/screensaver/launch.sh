#!/usr/bin/env bash
# Opens the Phosphor-OS screensaver page (page/saver.html) full screen on every monitor, in a Chromium kiosk window
# each, and stays until it gets SIGTERM (Service.qml sends it on the first input) or its parent shell is gone.
# Run: bash launch.sh idle|force     force = also when "stay awake" or the screensaver-off toggle is on.
# Needs Hyprland, jq and Chromium (or Chrome / Brave).
set -u

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
page=$here/page/saver.html
state=$HOME/.local/state/omarchy
class=phosphor-os-screensaver

[[ -f $page ]] || exit 1
if [[ ${1:-idle} != force ]]; then
  [[ -e $state/indicators/stay-awake || -e $state/toggles/screensaver-off ]] && exit 0
  [[ $(omarchy-shell lock isLocked 2>/dev/null) == true ]] && exit 0
fi
browser=
for b in chromium chromium-browser google-chrome-stable brave; do
  command -v "$b" >/dev/null && browser=$b && break
done
[[ -n $browser ]] || exit 1
# One saver at a time (the menu entry while the idle one shows).
[[ -n $(hyprctl clients -j | jq -r --arg c "$class" '.[]|select(.class==$c)|.address' 2>/dev/null) ]] && exit 0

# The theme: the pack's own by name, any other Omarchy theme by its colors.
hash=
case $(cat "$state/current/theme.name" 2>/dev/null) in
  retro-amber) hash=t=amber ;;
  retro-green) hash=t=green ;;
  lcars) hash=t=lcars ;;
  *)
    col() { sed -n "s/^$1 *= *\"#\([0-9a-fA-F]\{6\}\)\".*/\1/p" "$state/current/theme/colors.toml" 2>/dev/null | head -n 1; }
    c="$(col foreground),$(col bright_foreground),$(col dark_foreground),$(col background),$(col lighter_background)"
    [[ $c =~ ^([0-9a-fA-F]{6},){4}[0-9a-fA-F]{6}$ ]] && hash=c=$c
    ;;
esac

profile=${XDG_RUNTIME_DIR:-/tmp}/phosphor-os-saver.$$
pid=
# Focusing the other monitor (to open its window there) warps the pointer, and the page closes on a pointer move:
# with two monitors the saver closed itself seconds after it showed, every time, so the displays never went off
# (2026-10-19 to 10-21). So no pointer warps while the windows open; the setting goes back afterwards.
warps=$(hyprctl getoption cursor:no_warps 2>/dev/null | sed -n 's/^bool: //p' | head -n 1)
warps() { [[ -n $warps ]] && hyprctl eval "hl.config({ cursor = { no_warps = $1 } })" >/dev/null 2>&1; }
cleanup() {
  trap - EXIT TERM INT HUP
  warps "$warps"
  if [[ -n $pid ]]; then
    kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null
    pkill -9 -f -- "--user-data-dir=$profile" 2>/dev/null # its helpers (the folder name has this script's PID in it)
  fi
  rm -rf "$profile"
  exit 0
}
trap cleanup EXIT TERM INT HUP

focus() { hyprctl dispatch "hl.dsp.focus({ monitor = \"$1\" })" >/dev/null 2>&1; }
windows() { hyprctl clients -j | jq --arg c "$class" '[.[]|select(.class==$c)]|length'; }

focused=$(hyprctl monitors -j | jq -r '.[]|select(.focused).name')
warps true
for m in $(hyprctl monitors -j | jq -r '.[].name'); do
  focus "$m"
  have=$(windows)
  # The first run starts the browser; the next ones hand their window to it (same profile folder).
  "$browser" --user-data-dir="$profile" --class="$class" --ozone-platform=wayland --kiosk "file://$page#$hash" \
    --no-first-run --no-default-browser-check --disable-extensions --disable-sync --disable-background-networking \
    --disable-component-update --noerrdialogs --disable-session-crashed-bubble >/dev/null 2>&1 &
  [[ -n $pid ]] || pid=$!
  for _ in $(seq 100); do # up to 10 s for this window to show
    [[ $(windows) -gt $have ]] && break
    sleep 0.1
  done
done
[[ -n $focused ]] && focus "$focused"
warps "$warps"

# Stay until told to stop (SIGTERM), or until the browser is gone, the shell that started us is gone, a window of
# ours was closed (the page closes itself on input) or focus left the saver (Alt+Tab, a click elsewhere).
want=$(windows)
parent=$PPID
sleep 1.5
while kill -0 "$pid" 2>/dev/null && kill -0 "$parent" 2>/dev/null &&
  [[ $(windows) -ge $want && $(hyprctl activewindow -j | jq -r .class) == "$class" ]]; do
  sleep 0.5 &
  wait $!
done
