// Phosphor-OS screensaver: THE screensaver of the whole computer (the app's look, page/saver.html, full screen on
// every monitor). It replaces Omarchy's: desktop.sh sets Omarchy's own idle.screensaver to "never" and this
// service watches the idle time itself. After IDLE_SECONDS with no input it runs launch.sh, which opens the page
// in a kiosk window per monitor; any key, mouse move, click or scroll ends it (the compositor's idle signal, and
// the page itself closes on input too; no password). The displays go off after SCREEN_OFF_SECONDS idle on their own
// watch, whether the screensaver still shows or not (it is only for the look); the first input turns them on again.
// Still on after 3 h without input (an app that blocks idle, a video left "playing", 2026-11-12: the displays were on
// every morning), the displays go off anyway: nobody watches a screen for 3 h without touching anything.
// Every step goes to ~/.local/state/phosphor-os/screens.log (time, event, playing media, active window).
// `omarchy-shell phosphor-os.screensaver show` starts it by hand (the Omarchy menu entry does).
// Turned on by { "id": "phosphor-os.screensaver" } in plugins[] of ~/.config/omarchy/shell.json.
import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Services.Mpris
import Quickshell.Wayland

Scope {
  id: root

  readonly property int idleSeconds: 300
  readonly property int screenOffSeconds: 30 * 60
  readonly property int forceOffSeconds: 3 * 60 * 60
  property bool screensOff: false
  readonly property string launcher: decodeURIComponent(Qt.resolvedUrl("launch.sh").toString().replace("file://", ""))
  readonly property bool on: saver.running
  // A video or song playing (any MPRIS player: Firefox, Chromium, mpv, Spotify) keeps the screensaver away.
  // Browsers ask for that with a D-Bus screensaver inhibit that nothing on Omarchy answers, and a windowed
  // video sets no Wayland inhibitor, so the player state is the signal that works.
  readonly property bool mediaPlaying: (Mpris.players ? Mpris.players.values : []).some(function(p) { return p.isPlaying })
  readonly property string playing: (Mpris.players ? Mpris.players.values : []).filter(function(p) { return p.isPlaying }).map(function(p) { return p.identity || p.dbusName }).join("+") || "none"

  // One line per step in the log file; the file keeps its last 2000 lines.
  function log(event) {
    Quickshell.execDetached(["bash", "-c",
      'f="$HOME/.local/state/phosphor-os/screens.log"; mkdir -p "${f%/*}"; ' +
      'printf "%s %s media=%s active=%s\\n" "$(date "+%F %T")" "$1" "$2" "$(hyprctl activewindow -j 2>/dev/null | jq -r ".class // \\"none\\"")" >> "$f"; ' +
      '(( $(wc -l < "$f") > 3000 )) && sed -i 1,1000d "$f"', "log", event, root.playing])
  }

  function start(force) {
    if (saver.running) return
    saver.command = ["bash", launcher, force ? "force" : "idle"]
    saver.running = true
  }

  function stop() {
    if (!saver.running) return
    saver.running = false // SIGTERM: launch.sh closes its windows and removes its profile folders
  }

  // However it ended (input, a closed window, focus left it): the displays on again, as Omarchy's idle does.
  Process {
    id: saver
    onRunningChanged: {
      root.log(running ? "saver-start" : "saver-end")
      if (!running) Quickshell.execDetached(["omarchy-system-wake"])
    }
  }

  // After 5 min idle. Inhibitors (a full-screen game) are respected, as in Omarchy's own idle; so is playing media.
  IdleMonitor {
    id: idle
    timeout: root.idleSeconds
    respectInhibitors: true
    onIsIdleChanged: {
      root.log(isIdle ? "idle-5min" : "input")
      if (isIdle && !root.mediaPlaying) root.start(false)
    }
  }

  // The media stopped while nobody is at the PC: the full idle time again from then, not at once.
  onMediaPlayingChanged: {
    if (!mediaPlaying && idle.isIdle) afterMedia.restart(); else afterMedia.stop()
    if (!mediaPlaying && offIdle.isIdle) offAfterMedia.restart(); else offAfterMedia.stop()
  }
  Timer {
    id: afterMedia
    interval: root.idleSeconds * 1000
    onTriggered: if (idle.isIdle && !root.mediaPlaying) root.start(false)
  }

  // While it shows: the first input after a second of quiet (the PC is idle already) ends it.
  IdleMonitor {
    enabled: root.on
    timeout: 1
    respectInhibitors: false
    onIsIdleChanged: if (!isIdle) root.stop()
  }

  // The displays off after 30 min idle (the PC keeps running: no lock, no sleep). Its own watch: it used to start
  // with the screensaver, so a screensaver that closed early (every 5 min all night with two monitors, 2026-10-19
  // to 10-21) kept the displays on. Inhibitors (a full-screen game) and playing media keep them on.
  function screensOffNow(force) {
    if (root.screensOff) return
    if (root.mediaPlaying && !force) return root.log("off-skipped-media")
    root.screensOff = true
    root.log(force ? "screens-off-forced" : "screens-off")
    Quickshell.execDetached(["omarchy-brightness-display", "off"])
  }

  IdleMonitor {
    id: offIdle
    timeout: root.screenOffSeconds
    respectInhibitors: true
    onIsIdleChanged: {
      if (isIdle) root.screensOffNow(false)
      else if (root.screensOff) root.screensOnAgain()
    }
  }

  function screensOnAgain() {
    root.screensOff = false
    root.log("screens-on-input")
    Quickshell.execDetached(["omarchy-system-wake"])
  }

  // The same 30 min without inhibitors, for the log only: idle here but not above = an app blocks idle.
  IdleMonitor {
    timeout: root.screenOffSeconds
    respectInhibitors: false
    onIsIdleChanged: if (isIdle && !offIdle.isIdle) root.log("idle-blocked-by-inhibitor")
  }

  // The net: 3 h without any input, the displays go off whatever blocks idle or plays. Input turns them on again.
  IdleMonitor {
    id: forceIdle
    timeout: root.forceOffSeconds
    respectInhibitors: false
    onIsIdleChanged: {
      if (isIdle) root.screensOffNow(true)
      else if (root.screensOff && !offIdle.isIdle) root.screensOnAgain()
    }
  }

  // An HDMI monitor that loses its signal can drop off and come back a moment later (a hotplug); Hyprland then
  // turns it on again, so the second monitor showed the screensaver all night (2026-10-22). While the displays
  // should be off, a monitor that comes back goes off at once (the MSI on HDMI did it every minute or so, 163 times
  // in one evening, and each time it lit up until the 30 s check: 2026-10-27), and the check catches anything else.
  Connections {
    target: Hyprland
    enabled: root.screensOff
    function onRawEvent(event) {
      if (event && String(event.name).indexOf("monitoradded") === 0) {
        root.log("monitor-back-off-again")
        Quickshell.execDetached(["omarchy-brightness-display", "off"])
      }
    }
  }
  Timer {
    running: root.screensOff
    interval: 30 * 1000
    repeat: true
    onTriggered: Quickshell.execDetached(["bash", "-c", "hyprctl monitors -j | jq -e 'all(.[]; .dpmsStatus | not)' >/dev/null || omarchy-brightness-display off"])
  }

  // The media stopped while nobody is at the PC: the full 30 min again from then.
  Timer {
    id: offAfterMedia
    interval: root.screenOffSeconds * 1000
    onTriggered: if (offIdle.isIdle) root.screensOffNow(false)
  }

  IpcHandler {
    target: "phosphor-os.screensaver"

    function show(): void { root.start(true) }
  }
}
