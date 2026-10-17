// Phosphor-OS screensaver: THE screensaver of the whole computer (the app's look, page/saver.html, full screen on
// every monitor). It replaces Omarchy's: desktop.sh sets Omarchy's own idle.screensaver to "never" and this
// service watches the idle time itself. After IDLE_SECONDS with no input it runs launch.sh, which opens the page
// in a kiosk window per monitor; any key, mouse move, click or scroll ends it (the compositor's idle signal, and
// the page itself closes on input too; no password). SCREEN_OFF_MS later it turns the displays off; waking runs Omarchy's own omarchy-system-wake.
// `omarchy-shell phosphor-os.screensaver show` starts it by hand (the Omarchy menu entry does).
// Turned on by { "id": "phosphor-os.screensaver" } in plugins[] of ~/.config/omarchy/shell.json.
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Mpris
import Quickshell.Wayland

Scope {
  id: root

  readonly property int idleSeconds: 300
  readonly property int screenOffMs: 25 * 60 * 1000 // 30 min idle in all
  readonly property string launcher: decodeURIComponent(Qt.resolvedUrl("launch.sh").toString().replace("file://", ""))
  readonly property bool on: saver.running
  // A video or song playing (any MPRIS player: Firefox, Chromium, mpv, Spotify) keeps the screensaver away.
  // Browsers ask for that with a D-Bus screensaver inhibit that nothing on Omarchy answers, and a windowed
  // video sets no Wayland inhibitor, so the player state is the signal that works.
  readonly property bool mediaPlaying: (Mpris.players ? Mpris.players.values : []).some(function(p) { return p.isPlaying })

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
    onRunningChanged: if (!running) Quickshell.execDetached(["omarchy-system-wake"])
  }

  // After 5 min idle. Inhibitors (a full-screen game) are respected, as in Omarchy's own idle; so is playing media.
  IdleMonitor {
    id: idle
    timeout: root.idleSeconds
    respectInhibitors: true
    onIsIdleChanged: if (isIdle && !root.mediaPlaying) root.start(false)
  }

  // The media stopped while nobody is at the PC: the full idle time again from then, not at once.
  onMediaPlayingChanged: if (!mediaPlaying && idle.isIdle) afterMedia.restart(); else afterMedia.stop()
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

  Timer {
    running: root.on
    interval: root.screenOffMs
    onTriggered: Quickshell.execDetached(["omarchy-brightness-display", "off"])
  }

  IpcHandler {
    target: "phosphor-os.screensaver"

    function show(): void { root.start(true) }
  }
}
