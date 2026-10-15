#!/usr/bin/env bash
# The Retro Claude look for Omarchy 4: theme, VT323 font, the bar at the bottom with a taskbar, no idle lock,
# the screensaver in the theme's look.
# docs/OMARCHY.md lists every change, why, and how to undo it.
#
# Run:  bash os/omarchy/desktop.sh [--theme NAME] [--dry-run] [--undo]
#   --theme NAME   retro-amber (default), retro-green or lcars
#   --dry-run      print what it would change, change nothing
#   --undo         take back what this script changed, and only that
#
# Safe to run again: it looks first and skips what is done. scripts/setup-linux.sh runs it in its step 8.
# Notes for --undo go to $XDG_STATE_HOME/RetroClaude/desktop.state, backups to desktop-backup/ next to it.

set -euo pipefail

DRY=0
UNDO=0
THEME=retro-amber
FONT=VT323

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
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
SAVER="$CFG/plugins/retro-claude.screensaver"
DEFAULT_JSON="${OMARCHY_PATH:-/usr/share/omarchy}/config/omarchy/shell.json"

state_home=${XDG_STATE_HOME:-}
[[ $state_home == /* ]] || state_home="$HOME/.local/state"
STATE_DIR="$state_home/RetroClaude"
STATE="$STATE_DIR/desktop.state"
BACKUP="$STATE_DIR/desktop-backup"

NODE=${RETRO_NODE:-}
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
  const saver = (e) => e?.id === "retro-claude.screensaver";
  if (mode === "json-apply") {
    if (bar.position !== "bottom") { notes.push(`position=${bar.position ?? ""}`); bar.position = "bottom"; }
    if (at < 0) {
      const w = left.findIndex((e) => e?.id === "omarchy.workspaces");
      left.splice(w < 0 ? left.length : w + 1, 0, { id: "omarchy.spacer", size: 12 }, { id: "taskbar", type: "qml" });
      notes.push("taskbar=1");
    }
    if (idle.lock !== 2000000) { notes.push(`lock=${idle.lock ?? ""}`); idle.lock = 2000000; }
    if (!c.plugins?.some(saver)) { (c.plugins ??= []).push({ id: "retro-claude.screensaver" }); notes.push("saver=1"); }
  } else {
    if ("position" in old && bar.position === "bottom") old.position ? (bar.position = old.position) : delete bar.position;
    if ("lock" in old && idle.lock === 2000000) old.lock ? (idle.lock = Number(old.lock)) : delete idle.lock;
    const spacer = left[at - 1]?.id === "omarchy.spacer" && left[at - 1].size === 12;
    if (old.taskbar && at >= 0) left.splice(spacer ? at - 1 : at, spacer ? 2 : 1);
    if (old.saver && Array.isArray(c.plugins)) c.plugins = c.plugins.filter((e) => !saver(e));
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
  notes="$("$NODE" -e "$EDIT_JS" "$tag-apply" "$src" "$new")"
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
  local tag=$1 file=$2 new="$TMP/$1.new"
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
  drop $(sed -n "s/^\(${tag}_[^=]*\)=.*/\1/p" "$STATE")
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

# A shell plugin that draws over Omarchy's own screensaver. A copy, not a link: Omarchy refuses linked plugins.
# After an update the running shell keeps the old code until `omarchy restart shell`.
saver_step() {
  local src="$PACK/screensaver"
  if diff -rq "$src" "$SAVER" >/dev/null 2>&1; then
    say "  Screensaver: $SAVER is up to date."
    return 0
  fi
  if [[ -e $SAVER || -L $SAVER ]]; then
    if noted saver_dir; then
      run rm -rf "$SAVER" # ours, from an earlier run
    else
      run mkdir -p "$BACKUP"
      run mv "$SAVER" "$BACKUP/${SAVER##*/}"
      put saver_dir replaced
    fi
  fi
  [[ -d ${SAVER%/*} ]] || keep saver_parent 1
  keep saver_dir new
  run mkdir -p "${SAVER%/*}"
  run cp -r "$src" "$SAVER"
  ((DRY)) || say "  Screensaver: copied to $SAVER."
}

# ------------------------------------------------------------------ undo

undo() {
  if [[ ! -f $STATE ]]; then
    say "  Nothing to undo (no notes in $STATE)."
    exit 0
  fi
  undo_edit json "$SHELL_JSON"
  if noted saver_dir; then
    run rm -rf "$SAVER"
    if [[ $(recall saver_dir) == replaced ]]; then run mv "$BACKUP/${SAVER##*/}" "$SAVER"; fi
    if noted saver_parent; then ((DRY)) || rmdir "${SAVER%/*}" 2>/dev/null || true; fi
    drop saver_dir saver_parent
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
  ((DRY)) || say "  The Retro Claude look is taken back."
  exit 0
fi
command -v omarchy >/dev/null || die "This is for Omarchy 4: the 'omarchy' command is not here."
theme_step
font_step
bar_step
saver_step
apply_edit json "$SHELL_JSON" "$DEFAULT_JSON" # last: it names the taskbar and the screensaver plugin, now in place
((DRY)) || say "  The Retro Claude look is on. Undo: bash $(printf '%q' "$PACK/desktop.sh") --undo"
