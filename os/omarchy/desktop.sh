#!/usr/bin/env bash
# The Phosphor-OS look for Omarchy 4: theme, VT323 font, the bar at the bottom with a taskbar, no idle lock,
# the screensaver (the app's flight scene, on every monitor), notifications that wait in a bar counter until dismissed, the indicator
# toggles in a popup over the clock, a night light schedule (a systemd user timer), the mic indicator for
# DICTATE in any app (Ctrl+Space; the key itself is in os/hyprland/phosphor-os.lua).
# docs/OMARCHY.md lists every change, why, and how to undo it.
#
# Run:  bash os/omarchy/desktop.sh [--theme NAME] [--dry-run] [--undo]
#   --theme NAME   retro-amber (default), retro-green or lcars
#   --dry-run      print what it would change, change nothing
#   --undo         take back what this script changed, and only that
#
# Safe to run again: it looks first and skips what is done. scripts/setup-linux.sh runs it in its step 8.
# Notes for --undo go to $XDG_STATE_HOME/PhosphorOS/desktop.state, backups to desktop-backup/ next to it.
# Made under the old name (Retro Claude, until 2026-10-12)? It reads the old RetroClaude notes, swaps the old
# screensaver plugin id for the new one, and --undo takes back either.

set -euo pipefail

DRY=0
UNDO=0
THEME=retro-amber
FONT=VT323

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
say() { printf '%s\n' "$*"; }
die() {
  printf '\nSTOP: %s\n' "$*" >&2
  exit 1
}
run() { # every change goes through here: a dry run prints it instead
  if ((DRY)); then
    local out=() a
    for a in "$@"; do out+=("$(printf '%q' "$a")"); done
    say "  [dry-run] ${out[*]}"
  else
    "$@"
  fi
}
copy_into() { # src dst: write through (keeps the file's mode, and a symlink stays a symlink)
  if ((DRY)); then say "  [dry-run] write $2"; else cat "$1" >"$2"; fi
}

while (($#)); do
  case $1 in
    --dry-run) DRY=1 ;;
    --undo) UNDO=1 ;;
    --theme)
      THEME=${2:-}
      [[ $# -gt 1 ]] && shift
      ;;
    --theme=*) THEME=${1#*=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

PACK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[[ $THEME =~ ^[a-z0-9-]+$ && -d $PACK/themes/$THEME ]] || die "Unknown theme '$THEME'. Pick one of: $(ls "$PACK/themes" | tr '\n' ' ')"

# Omarchy reads these under $HOME whatever XDG_CONFIG_HOME says.
CFG="$HOME/.config/omarchy"
THEME_NAME_FILE="$HOME/.local/state/omarchy/current/theme.name"
SHELL_JSON="$CFG/shell.json"
SHELL_TOML="$CFG/shell.toml"
TASKBAR="$CFG/bar/modules/taskbar.qml"
SAVER="$CFG/plugins/phosphor-os.screensaver"
MENU="$CFG/extensions/omarchy-menu.jsonc"
MENU_MARK="phosphor-os:menu" # on the line we add to the menu file; undo takes it out by this
REPO="$(cd "$PACK/../.." && pwd -P)"
PAGE_SRC="$REPO/web/dist/saver" # the screensaver page, built by `npm run build`
EDIT_ARGS=() # key=value pairs handed to the JSON edit (nosaver=1: the page is not built, leave the screensaver alone)
OLD_SAVER="$CFG/plugins/retro-claude.screensaver" # its name before the rename (note saver_dir)
NOTIF="$CFG/plugins/phosphor-os.notifications"
CLOCK="$CFG/plugins/phosphor-os.clock"
DICT="$CFG/plugins/phosphor-os.dictate" # the floating mic's plugin, until 2026-10-26 (dict_off takes it out)
config_home=${XDG_CONFIG_HOME:-}
[[ $config_home == /* ]] || config_home="$HOME/.config"
UNIT_DIR="$config_home/systemd/user"
NL_UNITS=(phosphor-os-nightlight.service phosphor-os-nightlight.timer)
NL_TIMER=phosphor-os-nightlight.timer
DEFAULT_JSON="${OMARCHY_PATH:-/usr/share/omarchy}/config/omarchy/shell.json"

state_home=${XDG_STATE_HOME:-}
[[ $state_home == /* ]] || state_home="$HOME/.local/state"
STATE_DIR="$state_home/PhosphorOS"
if [[ ! -e $STATE_DIR && -d $state_home/RetroClaude ]]; then STATE_DIR="$state_home/RetroClaude"; fi # notes from before the rename
STATE="$STATE_DIR/desktop.state"
BACKUP="$STATE_DIR/desktop-backup"

NODE=${PHOSPHOR_NODE:-}
[[ -x $NODE ]] || NODE="$(command -v node || true)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ------------------------------------------------------------------ notes for --undo (key=value lines)

noted() { grep -q "^$1=" "$STATE" 2>/dev/null; }
recall() { sed -n "s/^$1=//p" "$STATE" 2>/dev/null | head -n 1; }
drop() {
  ((DRY)) && return 0
  [[ -f $STATE ]] || return 0
  local k rest
  rest="$(cat "$STATE")"
  for k in "$@"; do rest="$(grep -v "^$k=" <<<"$rest" || true)"; done
  if [[ -n $rest ]]; then printf '%s\n' "$rest" >"$STATE"; else rm -f "$STATE"; fi
}
put() { # key value: replace
  ((DRY)) && return 0
  drop "$1"
  mkdir -p "$STATE_DIR"
  printf '%s=%s\n' "$1" "$2" >>"$STATE"
}
keep() { noted "$1" || put "$1" "$2"; } # key value: only the first time, so --undo goes back to what was there before us
sum() { sha256sum "$1" | cut -d' ' -f1; }
current_theme() { cat "$THEME_NAME_FILE" 2>/dev/null || true; }

# ------------------------------------------------------------------ shell.json and shell.toml

# mode src dst [key=value...]: writes the edited file to dst; on apply, prints key=old-value for each key it changed.
# JSON is written like Omarchy's own `omarchy bar` writes it (jq -S: sorted keys, 2 spaces). Apply also writes
# dst.old: the old file in that form, so a dry run shows only real changes.
# shellcheck disable=SC2016 # JavaScript, not shell
EDIT_JS='
const fs = require("fs");
const [mode, src, dst, ...pairs] = process.argv.slice(1);
const old = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
const text = fs.readFileSync(src, "utf8");
const notes = [];
let out;
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
if (mode.startsWith("json")) {
  const c = JSON.parse(text || "{}");
  const bar = (c.bar ??= {}), left = ((bar.layout ??= {}).left ??= []), idle = (c.idle ??= {});
  const at = left.findIndex((e) => e?.id === "taskbar");
  const saver = (e) => e?.id === "phosphor-os.screensaver";
  // Our copy of the Omarchy notifications replaces the built-in (as `omarchy plugin clone` does it: the copy in
  // plugins[], the built-in in disabledPlugins[]); its counter goes last in the bar, after the clock.
  const NOTIF = "phosphor-os.notifications", BUILTIN = "omarchy.notifications", notif = (e) => e?.id === NOTIF;
  const inBar = (id) => ["left", "center", "right"].some((s) => bar.layout?.[s]?.some((e) => e?.id === id));
  // The clock and the indicators become one widget where the clock was: hover the clock for the toggles.
  const CLK = "phosphor-os.clock", IND = "omarchy.indicators", IND_KEYS = ["items", "indicators", "alwaysShow"];
  const where = (id) => {
    for (const s of ["left", "center", "right"]) { const i = (bar.layout[s] ?? []).findIndex((e) => e?.id === id); if (i >= 0) return [s, i]; }
    return null;
  };
  const oldSaver = (e) => e?.id === "retro-claude.screensaver"; // the plugin id before the rename
  const DICT = "phosphor-os.dictate", dict = (e) => e?.id === DICT; // the floating mic plugin, until 2026-10-26
  // Clock, weather and indicators sit bottom right like Windows; the middle of the bar stays empty.
  // The clock: day, 12-hour time, then the date ("Thursday 2:14 PM 10/22/26"). OURS: every format the pack has set.
  const lay = bar.layout, CLOCK = "dddd h:mm AP MM/dd/yy", OURS = [CLOCK, "dddd h:mm AP"];
  const FRONT = ["omarchy.indicators", "omarchy.system-update", "omarchy.keyboard-layout"], END = ["omarchy.weather", "omarchy.clock"];
  const clock = () => [...(lay.right ?? []), ...(lay.center ?? [])].find((e) => e?.id === "omarchy.clock" || e?.id === CLK);
  if (mode === "json-apply") {
    if (c.plugins?.some(oldSaver)) { c.plugins = c.plugins.filter((e) => !oldSaver(e)); notes.push("saver=1"); }
    if (bar.position !== "bottom") { notes.push(`position=${bar.position ?? ""}`); bar.position = "bottom"; }
    if (at < 0) {
      const w = left.findIndex((e) => e?.id === "omarchy.workspaces");
      left.splice(w < 0 ? left.length : w + 1, 0, { id: "omarchy.spacer", size: 12 }, { id: "taskbar", type: "qml" });
      notes.push("taskbar=1");
    }
    if (idle.lock !== 2000000) { notes.push(`lock=${idle.lock ?? ""}`); idle.lock = 2000000; }
    // Omarchy never starts its own screensaver (like its lock): the pack plugin watches the idle time itself.
    if (!old.nosaver && idle.screensaver !== 2000000) { notes.push(`screensaver=${idle.screensaver ?? ""}`); idle.screensaver = 2000000; }
    if (!old.nosaver && !c.plugins?.some(saver)) { (c.plugins ??= []).push({ id: "phosphor-os.screensaver" }); notes.push("saver=1"); }
    const center = lay.center ?? [];
    if (center.length) {
      notes.push(`center=${JSON.stringify(center)}`);
      const pick = (ids) => ids.map((id) => center.find((e) => e?.id === id)).filter(Boolean);
      const rest = center.filter((e) => ![...FRONT, ...END].includes(e?.id));
      lay.right = [...pick(FRONT), ...rest, ...(lay.right ?? []), ...pick(END)];
      lay.center = [];
    }
    const k = clock();
    if (k && k.format !== CLOCK) {
      if (!("clock" in old)) notes.push(`clock=${k.format ?? ""}`); // the format from before the pack, kept once
      k.format = CLOCK;
    }
    if (!(c.plugins ??= []).some(notif)) { c.plugins.push({ id: NOTIF }); notes.push("notif=1"); }
    // The floating mic is gone: its entry goes. The note is only there so this edit gets written (dict_off drops it).
    if (c.plugins.some(dict)) { c.plugins = c.plugins.filter((e) => !dict(e)); notes.push("dict=1"); }
    if (!c.disabledPlugins?.includes(BUILTIN)) {
      (c.disabledPlugins ??= []).push(BUILTIN);
      (c.cloneSourceRestores ??= []).includes(NOTIF) || c.cloneSourceRestores.push(NOTIF); // the Omarchy off switch for the copy brings the built-in back
      notes.push("notifoff=1");
    }
    const kAt = where("omarchy.clock"), iAt = where(IND);
    if (kAt && !where(CLK)) {
      const mine = { ...lay[kAt[0]][kAt[1]], id: CLK };
      if (iAt) {
        const ind = lay[iAt[0]][iAt[1]];
        for (const k of IND_KEYS) if (k in ind) mine[k] = ind[k];
        notes.push(`ind=${JSON.stringify({ at: iAt, entry: ind })}`);
      }
      lay[kAt[0]][kAt[1]] = mine;
      if (iAt) lay[iAt[0]].splice(iAt[1], 1);
      notes.push("clk=1");
    }
    if (!inBar(NOTIF)) { (lay.right ??= []).push({ id: NOTIF }); notes.push("counter=1"); }
  } else {
    const without = (list, x) => { if (!Array.isArray(c[list])) return; c[list] = c[list].filter((e) => e !== x); if (!c[list].length) delete c[list]; };
    if (old.counter) for (const list of Object.values(lay)) // in place: `left` above must stay the same array
      for (let i = Array.isArray(list) ? list.length - 1 : -1; i >= 0; i--) if (notif(list[i])) list.splice(i, 1);
    if (old.notifoff) { without("disabledPlugins", BUILTIN); without("cloneSourceRestores", NOTIF); }
    if (old.notif && Array.isArray(c.plugins)) c.plugins = c.plugins.filter((e) => !notif(e));
    if (old.dict && Array.isArray(c.plugins)) c.plugins = c.plugins.filter((e) => !dict(e));
    const mAt = old.clk ? where(CLK) : null;
    if (mAt) { // back to the Omarchy clock and indicators, keeping settings changed since
      const mine = lay[mAt[0]][mAt[1]], clk = { ...mine, id: "omarchy.clock" };
      for (const k of IND_KEYS) delete clk[k];
      lay[mAt[0]][mAt[1]] = clk;
      if (old.ind && !where(IND)) {
        const { at: [s, i], entry } = JSON.parse(old.ind), back = { ...entry };
        for (const k of IND_KEYS) { delete back[k]; if (k in mine) back[k] = mine[k]; }
        (lay[s] ??= []).splice(Math.min(i, lay[s].length), 0, back);
      }
    }
    if (old.center && !lay.center?.length) {
      const back = JSON.parse(old.center), ids = new Set(back.map((e) => e?.id));
      const now = new Map((lay.right ?? []).map((e) => [e?.id, e])); // keeps settings changed since
      lay.right = (lay.right ?? []).filter((e) => !ids.has(e?.id));
      lay.center = back.map((e) => now.get(e?.id) ?? e);
    }
    if ("clock" in old && OURS.includes(clock()?.format)) old.clock ? (clock().format = old.clock) : delete clock().format;
    if ("position" in old && bar.position === "bottom") old.position ? (bar.position = old.position) : delete bar.position;
    if ("lock" in old && idle.lock === 2000000) old.lock ? (idle.lock = Number(old.lock)) : delete idle.lock;
    // 300 was the value of the pack before the OS screensaver
    if ("screensaver" in old && [300, 2000000].includes(idle.screensaver)) old.screensaver ? (idle.screensaver = Number(old.screensaver)) : delete idle.screensaver;
    const spacer = left[at - 1]?.id === "omarchy.spacer" && left[at - 1].size === 12;
    if (old.taskbar && at >= 0) left.splice(spacer ? at - 1 : at, spacer ? 2 : 1);
    if (old.saver && Array.isArray(c.plugins)) c.plugins = c.plugins.filter((e) => !saver(e) && !oldSaver(e));
  }
  out = JSON.stringify(sorted(c), null, 2) + "\n";
} else {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => /^\s*\[font\]\s*(#.*)?$/.test(l));
  let end = lines.findIndex((l, i) => i > head && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const at = head < 0 ? -1 : lines.findIndex((l, i) => i > head && i < end && /^\s*base-size\s*=/.test(l));
  const value = at < 0 ? "" : lines[at].replace(/^[^=]*=\s*/, "").replace(/\s*(#.*)?$/, "");
  if (mode === "toml-apply" && value !== "16") {
    notes.push(`size=${value}`);
    if (at >= 0) lines[at] = "base-size = 16";
    else if (head >= 0) lines.splice(head + 1, 0, "base-size = 16");
    else {
      while (lines.length && lines.at(-1) === "") lines.pop();
      if (lines.length) lines.push("");
      lines.push("[font]", "base-size = 16", "");
    }
  } else if (mode === "toml-revert" && "size" in old && value === "16") {
    old.size ? (lines[at] = `base-size = ${old.size}`) : lines.splice(at, 1);
  }
  out = lines.join("\n");
}
fs.writeFileSync(dst, out);
if (mode.endsWith("apply")) fs.writeFileSync(dst + ".old", mode.startsWith("json") ? JSON.stringify(sorted(JSON.parse(text || "{}")), null, 2) + "\n" : text);
if (notes.length) console.log(notes.join("\n"));
'

show_diff() { # old new
  { diff -u "$1" "$2" || true; } | tail -n +3 | sed 's/^/    | /'
}

apply_edit() { # tag file source: put our keys into file (a missing file starts as a copy of source)
  local tag=$1 file=$2 src=$3 new="$TMP/$1.new" notes n
  [[ -f $file ]] && src=$file
  [[ -f $src ]] || src=/dev/null
  if [[ -z $NODE ]]; then
    ((DRY)) || die "Node is needed to edit $file (scripts/setup-linux.sh installs it)."
    say "  [dry-run] set our keys in $file (could not show how: no node on PATH)"
    return 0
  fi
  notes="$("$NODE" -e "$EDIT_JS" "$tag-apply" "$src" "$new" "${EDIT_ARGS[@]}")"
  if [[ -z $notes ]]; then
    say "  $file: already set."
    return 0
  fi
  if ((DRY)); then
    say "  [dry-run] change $file:"
    show_diff "$new.old" "$new"
    return 0
  fi
  if [[ ! -e $file ]]; then
    keep "${tag}_created" 1
  elif ! noted "${tag}_backup"; then
    mkdir -p "$BACKUP"
    cp -p "$file" "$BACKUP/${file##*/}"
    put "${tag}_backup" 1
  fi
  while IFS= read -r n; do keep "${tag}_${n%%=*}" "${n#*=}"; done <<<"$notes"
  mkdir -p "$(dirname "$file")"
  copy_into "$new" "$file"
  put "${tag}_sum" "$(sum "$file")"
  say "  Changed $file (the first backup is in $BACKUP)."
}

undo_edit() { # tag file
  local tag=$1 file=$2 new="$TMP/$1.new" keys
  noted "${tag}_sum" || return 0
  if [[ ! -f $file ]]; then
    say "  $file is gone: nothing to put back."
  elif [[ $(sum "$file") == "$(recall "${tag}_sum")" ]]; then
    if noted "${tag}_created"; then
      run rm -f "$file"
    else
      copy_into "$BACKUP/${file##*/}" "$file"
      run rm -f "$BACKUP/${file##*/}"
    fi
    ((DRY)) || say "  $file is back as it was."
  else
    # Changed since (by you or by Omarchy): put back only our keys, keep the rest.
    [[ -n $NODE ]] || die "Node is needed to edit $file."
    local args=()
    mapfile -t args < <(sed -n "s/^${tag}_//p" "$STATE")
    "$NODE" -e "$EDIT_JS" "$tag-revert" "$file" "$new" "${args[@]}"
    if ((DRY)); then
      say "  [dry-run] $file changed since setup; put back only our keys:"
      show_diff "$file" "$new"
    else
      copy_into "$new" "$file"
      say "  $file changed since setup: put back only our keys. Old copy: $BACKUP/${file##*/} (if there is one)."
    fi
  fi
  mapfile -t keys < <(sed -n "s/^\(${tag}_[^=]*\)=.*/\1/p" "$STATE")
  drop "${keys[@]}"
}

# ------------------------------------------------------------------ apply

theme_step() {
  local src="$PACK/themes/$THEME" dest="$CFG/themes/$THEME" cur changed=0
  if diff -rq "$src" "$dest" >/dev/null 2>&1; then
    say "  Theme files: $dest is up to date."
  else
    if [[ -e $dest ]]; then
      if noted "theme_dir_$THEME"; then
        run rm -rf "$dest" # ours, from an earlier run
      else
        run mkdir -p "$BACKUP/themes"
        run mv "$dest" "$BACKUP/themes/$THEME"
        put "theme_dir_$THEME" replaced
      fi
    fi
    keep "theme_dir_$THEME" new
    run mkdir -p "$CFG/themes"
    run cp -r "$src" "$dest"
    changed=1
  fi
  cur="$(current_theme)"
  if [[ $cur == "$THEME" ]] && ((!changed)); then
    say "  Theme $THEME: already on."
  else
    run omarchy theme set "$THEME"
    [[ $cur == "$THEME" ]] || keep theme_before "$cur"
    ((DRY)) || say "  Theme $THEME: on (was: ${cur:-unknown})."
  fi
}

font_step() {
  if bash "$PACK/install-fonts.sh" --check; then
    say "  Fonts VT323 and Antonio: already installed."
  else
    run bash "$PACK/install-fonts.sh"
    keep fonts 1
  fi
  local cur
  cur="$(omarchy font current 2>/dev/null || true)"
  if [[ $cur == "$FONT" ]]; then
    say "  Font $FONT: already on."
  else
    run omarchy font set "$FONT"
    keep font_before "$cur"
    ((DRY)) || say "  Font $FONT: on (was: ${cur:-unknown})."
  fi
  # VT323 is small for its size: bigger text in the bar and menus.
  apply_edit toml "$SHELL_TOML" /dev/null
}

bar_step() {
  local target="$PACK/bar/taskbar.qml"
  # The link comes before shell.json names the module: the bar rebuilds on that change and loads it then.
  if [[ -L $TASKBAR && $(readlink "$TASKBAR") == "$target" ]]; then
    say "  Taskbar: $TASKBAR already links to the pack."
  else
    if [[ -e $TASKBAR || -L $TASKBAR ]]; then
      if noted taskbar_link || noted taskbar_backup; then
        run rm -f "$TASKBAR"
      else
        run mkdir -p "$BACKUP"
        run mv "$TASKBAR" "$BACKUP/taskbar.qml"
        put taskbar_backup 1
      fi
    fi
    run mkdir -p "${TASKBAR%/*}"
    run ln -s "$target" "$TASKBAR"
    put taskbar_link 1
    ((DRY)) || say "  Taskbar: $TASKBAR now links to the pack."
  fi
}

# The screensaver: a shell plugin (idle watch, display off) with launch.sh and the built page (web/dist/saver) inside.
# A copy, not a link: Omarchy refuses linked plugins. After an update the running shell may keep the old code until
# `omarchy restart shell`. Without the built page nothing is changed: Omarchy's own screensaver stays.
# Before the rename the plugin folder was retro-claude.screensaver: take it out (the new one replaces it).
old_saver_off() {
  noted saver_dir || return 0
  run rm -rf "$OLD_SAVER"
  if [[ $(recall saver_dir) == replaced ]]; then run mv "$BACKUP/${OLD_SAVER##*/}" "$OLD_SAVER"; fi
  drop saver_dir
}

saver_step() {
  local src="$TMP/saver"
  old_saver_off
  if [[ ! -f $PAGE_SRC/saver.html ]]; then
    EDIT_ARGS+=(nosaver=1)
    say "  Screensaver: the page is not built ($PAGE_SRC). Run npm run build, then this again. Omarchy's own stays for now."
    return 0
  fi
  rm -rf "$src"
  mkdir -p "$src"
  cp -r "$PACK/screensaver/." "$src/"
  cp -r "$PAGE_SRC" "$src/page"
  if diff -rq "$src" "$SAVER" >/dev/null 2>&1; then
    say "  Screensaver: $SAVER is up to date."
    return 0
  fi
  if [[ -e $SAVER || -L $SAVER ]]; then
    if noted plugin_dir; then
      run rm -rf "$SAVER" # ours, from an earlier run
    else
      run mkdir -p "$BACKUP"
      run mv "$SAVER" "$BACKUP/${SAVER##*/}"
      put plugin_dir replaced
    fi
  fi
  [[ -d ${SAVER%/*} ]] || keep saver_parent 1
  keep plugin_dir new
  run mkdir -p "${SAVER%/*}"
  run cp -r "$src" "$SAVER"
  ((DRY)) || say "  Screensaver: copied to $SAVER."
}

# The Omarchy menu's Screensaver entry starts ours (the plugin's IPC call) instead of Omarchy's terminal effect: one line,
# added to the user's menu file, found again by its marker. No menu file, or no built page: nothing is added.
menu_step() {
  [[ -f $MENU ]] && ((${#EDIT_ARGS[@]} == 0)) || return 0
  if grep -q "$MENU_MARK" "$MENU"; then
    say "  Menu: the Screensaver entry is already ours."
    return 0
  fi
  local comma=""
  grep -qE '^\s*"' "$MENU" && comma="," # other entries follow
  local line="  \"system.screensaver\": {\"action\":\"omarchy-shell phosphor-os.screensaver show\"}$comma // $MENU_MARK"
  awk -v l="$line" '{print} !done && /^\{/ {print l; done=1}' "$MENU" >"$TMP/menu.new"
  copy_into "$TMP/menu.new" "$MENU"
  put menu_line 1
  ((DRY)) || say "  Menu: Screensaver now starts the Phosphor-OS one."
}

menu_undo() {
  noted menu_line || return 0
  if [[ -f $MENU ]] && grep -q "$MENU_MARK" "$MENU"; then
    grep -v "$MENU_MARK" "$MENU" >"$TMP/menu.back"
    copy_into "$TMP/menu.back" "$MENU"
  fi
  drop menu_line
}

# Our plugins, copies like the screensaver (os/omarchy/<name>): notifications that wait in a bar counter until
# dismissed; the clock with the indicator toggles on hover. Note <key>: new, or replaced (a folder of that name
# was there; it waits in the backup folder).
plugin_step() { # label src dst key
  local label=$1 src=$2 dst=$3 key=$4
  if diff -rq "$src" "$dst" >/dev/null 2>&1; then
    say "  $label: $dst is up to date."
    return 0
  fi
  if [[ -e $dst || -L $dst ]]; then
    if noted "$key"; then
      run rm -rf "$dst" # ours, from an earlier run
    else
      run mkdir -p "$BACKUP"
      run mv "$dst" "$BACKUP/${dst##*/}"
      put "$key" replaced
    fi
  fi
  [[ -d ${dst%/*} ]] || keep saver_parent 1
  keep "$key" new
  run mkdir -p "${dst%/*}"
  run cp -r "$src" "$dst"
  ((DRY)) || say "  $label: copied to $dst."
}

# The night light schedule: a user timer runs the clock plugin's phosphor-nightlight every minute (it switches
# only at the schedule's edges). Unit files are copies; a run with them up to date calls nothing.
nightlight_step() {
  local u changed=0
  for u in "${NL_UNITS[@]}"; do
    cmp -s "$PACK/nightlight/$u" "$UNIT_DIR/$u" && continue
    [[ -d $UNIT_DIR ]] || keep nl_mkdir "$([[ -d ${UNIT_DIR%/*} ]] && echo 1 || echo 2)" # 2: systemd/ too
    run mkdir -p "$UNIT_DIR"
    copy_into "$PACK/nightlight/$u" "$UNIT_DIR/$u"
    changed=1
  done
  if ((!changed)); then
    say "  Night light schedule: the timer is up to date."
    return 0
  fi
  keep nl_units 1
  run systemctl --user daemon-reload || true
  run systemctl --user enable --now "$NL_TIMER" || say "  Night light schedule: could not start the timer (no user systemd?)."
  ((DRY)) || say "  Night light schedule: $NL_TIMER on."
}

# DICTATE in any app: the clock's mic indicator (clock/Dictation.qml) watches this one-word file, which
# clock/phosphor-dictate writes. It has to exist before the bar starts, or the watch never sees it.
DICTATE_STATE="$state_home/phosphor-os/dictate"
dictate_step() {
  [[ -e $DICTATE_STATE ]] && return 0
  keep dictate_state 1
  [[ -d ${DICTATE_STATE%/*} ]] || keep dictate_dir 1
  run mkdir -p "${DICTATE_STATE%/*}"
  run touch "$DICTATE_STATE" # empty = idle
}

# The settings file (CLEAN UP for DICTATE in any app) is the app's: SETTINGS > VOICE writes it. The run that put the
# floating mic on (until 2026-10-26) made it too (dictate_settings): undo takes back what that run made.
DICTATE_SETTINGS="$HOME/.config/phosphor-os/dictate.json"
dictate_undo() {
  if noted dictate_state; then
    run rm -f "$DICTATE_STATE"
    drop dictate_state
    if noted dictate_dir; then # the folder too, if this made it and nothing else is in it now
      ((DRY)) || rmdir "${DICTATE_STATE%/*}" 2>/dev/null || true
      drop dictate_dir
    fi
  fi
  if noted dictate_settings; then
    run rm -f "$DICTATE_SETTINGS"
    drop dictate_settings
    if noted dictate_settings_dir; then
      ((DRY)) || rmdir "${DICTATE_SETTINGS%/*}" 2>/dev/null || true
      drop dictate_settings_dir
    fi
  fi
}

# The floating mic was a shell plugin until 2026-10-26; DICTATE in any app is Ctrl+Space with no mic on the desktop. A
# run takes the plugin out: its entry leaves shell.json (the edit before this) and its folder goes (a folder it replaced
# comes back). json_dict is the note that edit wrote only to get written.
dict_off() {
  if noted dict_dir; then
    plugin_undo "$DICT" dict_dir
    ((DRY)) || say "  Floating mic: taken out ($DICT). If it is still on the screen: omarchy restart shell"
  fi
  drop json_dict
}

# Pictures open in imv-dir (imv with the picture's whole folder, so Left/Right go to the previous and next
# picture) instead of imv (that one picture only). Only types whose default is imv: a viewer someone picked stays.
IMAGE_TYPES=(image/png image/jpeg image/webp image/gif image/bmp image/tiff)
viewer_step() {
  [[ -f /usr/share/applications/imv-dir.desktop ]] && command -v xdg-mime >/dev/null || return 0
  local t changed=0
  for t in "${IMAGE_TYPES[@]}"; do
    [[ $(xdg-mime query default "$t" 2>/dev/null) == imv.desktop ]] || continue
    run xdg-mime default imv-dir.desktop "$t"
    changed=1
  done
  if ((changed)); then
    keep viewer_dir 1
    ((DRY)) || say "  Pictures: open in imv-dir (Left/Right go through the folder)."
  fi
}

viewer_undo() {
  noted viewer_dir || return 0
  local t
  for t in "${IMAGE_TYPES[@]}"; do
    [[ $(xdg-mime query default "$t" 2>/dev/null) == imv-dir.desktop ]] && run xdg-mime default imv.desktop "$t"
  done
  drop viewer_dir
}

# mpv: YouTube's speed keys (Shift+> faster, Shift+< slower, up to 3x), a script linked into mpv's scripts folder.
MPV_SPEED="$config_home/mpv/scripts/phosphor-os-speed.lua"
mpv_step() {
  command -v mpv >/dev/null || return 0
  local target="$REPO/os/mpv/speed.lua"
  [[ -L $MPV_SPEED && $(readlink "$MPV_SPEED") == "$target" ]] && return 0
  if [[ -e $MPV_SPEED || -L $MPV_SPEED ]]; then
    say "  mpv: $MPV_SPEED is someone else's file; speed keys not added."
    return 0
  fi
  [[ -d ${MPV_SPEED%/*} ]] || keep mpv_dir "$([[ -d ${MPV_SPEED%/*/*} ]] && echo 1 || echo 2)"
  run mkdir -p "${MPV_SPEED%/*}"
  run ln -s "$target" "$MPV_SPEED"
  put mpv_speed 1
  ((DRY)) || say "  mpv: Shift+> and Shift+< change the speed like YouTube."
}

mpv_undo() {
  noted mpv_speed || return 0
  [[ -L $MPV_SPEED ]] && run rm -f "$MPV_SPEED"
  if ! ((DRY)); then
    case $(recall mpv_dir) in
      1) rmdir "${MPV_SPEED%/*}" 2>/dev/null || true ;;
      2) rmdir "${MPV_SPEED%/*}" "${MPV_SPEED%/*/*}" 2>/dev/null || true ;;
    esac
  fi
  drop mpv_speed
  drop mpv_dir
}

nightlight_undo() {
  noted nl_units || return 0
  local u
  run systemctl --user disable --now "$NL_TIMER" || true
  for u in "${NL_UNITS[@]}"; do run rm -f "$UNIT_DIR/$u"; done
  run systemctl --user daemon-reload || true
  run rm -f "$state_home/phosphor-os/nightlight-schedule" # its last applied state (the settings file stays)
  if ! ((DRY)); then
    rmdir "$state_home/phosphor-os" 2>/dev/null || true
    case $(recall nl_mkdir) in
      1) rmdir "$UNIT_DIR" 2>/dev/null || true ;;
      2) rmdir "$UNIT_DIR" "${UNIT_DIR%/*}" 2>/dev/null || true ;;
    esac
  fi
  drop nl_units nl_mkdir
}

plugin_undo() { # dst key
  noted "$2" || return 0
  run rm -rf "$1"
  if [[ $(recall "$2") == replaced ]]; then run mv "$BACKUP/${1##*/}" "$1"; fi
  drop "$2"
}

# ------------------------------------------------------------------ undo

undo() {
  if [[ ! -f $STATE ]]; then
    say "  Nothing to undo (no notes in $STATE)."
    exit 0
  fi
  undo_edit json "$SHELL_JSON"
  menu_undo
  old_saver_off
  plugin_undo "$NOTIF" notif_dir
  nightlight_undo
  dictate_undo
  viewer_undo
  mpv_undo
  plugin_undo "$CLOCK" clock_dir
  plugin_undo "$DICT" dict_dir # the floating mic, if an earlier run put it on
  if noted plugin_dir; then
    run rm -rf "$SAVER"
    if [[ $(recall plugin_dir) == replaced ]]; then run mv "$BACKUP/${SAVER##*/}" "$SAVER"; fi
    drop plugin_dir
  fi
  if noted saver_parent; then
    ((DRY)) || rmdir "${SAVER%/*}" 2>/dev/null || true
    drop saver_parent
  fi
  if noted taskbar_link; then
    if [[ -L $TASKBAR ]]; then run rm -f "$TASKBAR"; fi
    if noted taskbar_backup; then run mv "$BACKUP/taskbar.qml" "$TASKBAR"; fi
    ((DRY)) || rmdir "${TASKBAR%/*}" "$CFG/bar" 2>/dev/null || true
    drop taskbar_link taskbar_backup
  fi

  undo_edit toml "$SHELL_TOML"
  local before cur name
  if noted font_before; then
    before="$(recall font_before)"
    cur="$(omarchy font current 2>/dev/null || true)"
    if [[ -n $before && $cur == "$FONT" ]]; then run omarchy font set "$before"; fi
    drop font_before
  fi
  if noted fonts; then
    run bash "$PACK/install-fonts.sh" --undo
    drop fonts
  fi

  if noted theme_before; then
    before="$(recall theme_before)"
    cur="$(current_theme)"
    if [[ -n $before && -n $cur && -d $PACK/themes/$cur ]]; then run omarchy theme set "$before"; fi
    drop theme_before
  fi
  for name in $(sed -n 's/^theme_dir_\([^=]*\)=.*/\1/p' "$STATE" 2>/dev/null); do
    run rm -rf "$CFG/themes/$name"
    if [[ $(recall "theme_dir_$name") == replaced ]]; then run mv "$BACKUP/themes/$name" "$CFG/themes/$name"; fi
    drop "theme_dir_$name"
  done
  ((DRY)) || rmdir "$BACKUP/themes" "$BACKUP" "$STATE_DIR" 2>/dev/null || true
}

# ------------------------------------------------------------------ main

if ((DRY)); then say "  DRY RUN: nothing is changed."; fi
if ((UNDO)); then
  undo
  ((DRY)) || say "  The Phosphor-OS look is taken back."
  exit 0
fi
command -v omarchy >/dev/null || die "This is for Omarchy 4: the 'omarchy' command is not here."
theme_step
font_step
bar_step
saver_step
menu_step
plugin_step Notifications "$PACK/notifications" "$NOTIF" notif_dir
plugin_step Clock "$PACK/clock" "$CLOCK" clock_dir
nightlight_step # after the clock: the timer runs the script in its folder
dictate_step
viewer_step
mpv_step
apply_edit json "$SHELL_JSON" "$DEFAULT_JSON" # last: it names the taskbar and the plugins, now in place
dict_off # after it: the entry is out of shell.json before the folder goes
((DRY)) || say "  The Phosphor-OS look is on. Undo: bash $(printf '%q' "$PACK/desktop.sh") --undo"
