// Phosphor-OS floating mic: DICTATE in any app with a click. The take is the clock plugin's phosphor-dictate, the
// same one Ctrl+Space runs. A small round mic over every window on its monitor, on every workspace; full screen
// video and games cover it. It never takes the keyboard from the program you type in (a layer-shell surface with no
// keyboard focus), so the words go where the cursor was.
//   Click: start; click again: the words go in at the cursor.
//   Drag: move it; the spot is remembered. Dropped past a screen edge it goes onto the monitor on that side.
//   Right click: CLEAN UP on or off, HIDE THE MIC, OPEN PHOSPHOR-OS.
// Looks: idle, a dim mic; listening, red with a ring that moves with your voice; working, a turning arc; done, a
// tick; error, a short reason beside it. Hovering says what it does.
// Files: the take's state ~/.local/state/phosphor-os/dictate (line 1 idle|recording|transcribing|done|error, then the
// words or a reason), the mic level $XDG_RUNTIME_DIR/phosphor-dictate/level, and the settings
// ~/.config/phosphor-os/dictate.json ({ icon, cleanup, screen, x, y }; SETTINGS > VOICE in the app writes it too).
// `omarchy-shell phosphor-os.dictate show` brings a hidden mic back. Turned on by { "id": "phosphor-os.dictate" } in
// plugins[] of ~/.config/omarchy/shell.json (os/omarchy/desktop.sh).
import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons

Scope {
  id: root

  property var shell: null // set by the Omarchy shell; not used

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")
  readonly property string runDir: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/phosphor-dictate"
  // The take: the clock plugin's script (os/omarchy/clock), installed next to this plugin.
  readonly property string script: home + "/.config/omarchy/plugins/phosphor-os.clock/phosphor-dictate"

  property var settings: ({ icon: true, cleanup: false })
  property string take: "idle"
  property string reason: ""
  property real level: 0
  property string flash: "" // "done" or "error", for a moment after a take
  property string bubble: "" // the box beside the mic: "menu", "hint", "error" or none
  property bool started: false // the state file was read once: only later changes flash

  readonly property bool listening: take === "recording"
  readonly property bool working: take === "transcribing"
  readonly property color fg: Color.foreground
  readonly property color bg: Color.background
  readonly property color red: "#ff3b30" // the mic is on, in every theme (as in the bar's overlay)
  readonly property int disc: Style.space(34)
  readonly property int size: disc + Style.space(10) * 2 // room for the voice ring
  readonly property string family: Style.font.family

  // Where it sits: margins from the top left of the screen's usable area (the screen less the bar).
  readonly property var screenObj: pickScreen(settings.screen)
  readonly property var monitor: screenObj ? Hyprland.monitorFor(screenObj) : null
  readonly property var reserved: {
    var r = monitor && monitor.lastIpcObject ? monitor.lastIpcObject.reserved : null
    return r && r.length === 4 ? r : [0, 0, 0, 0]
  }
  readonly property real roomW: screenObj ? Math.max(0, screenObj.width - reserved[0] - reserved[2] - size) : 0
  readonly property real roomH: screenObj ? Math.max(0, screenObj.height - reserved[1] - reserved[3] - size) : 0
  readonly property bool onRight: left > roomW / 2
  property real left: 0
  property real top: 0
  property real overX: 0 // how far a drag went past the edge (to hop onto the next monitor)
  property real overY: 0

  function pickScreen(name) {
    var list = Quickshell.screens
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i]
    return list.length ? list[0] : null
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

  // From the saved spot (0..1 of the room; first time: the right edge, low down, above the bar).
  function place() {
    if (mouse.dragging) return
    var x = Number(settings.x), y = Number(settings.y)
    left = clamp(isFinite(x) && settings.x !== undefined ? x : 1, 0, 1) * roomW
    top = clamp(isFinite(y) && settings.y !== undefined ? y : 0.85, 0, 1) * roomH
  }
  onRoomWChanged: place()
  onRoomHChanged: place()

  function save(patch) {
    var next = {}
    for (var k in settings) next[k] = settings[k]
    for (var p in patch) next[p] = patch[p]
    settings = next
    settingsFile.setText(JSON.stringify(next, null, 2) + "\n")
  }

  function moveTo(l, t) {
    overX = l < 0 ? l : l > roomW ? l - roomW : 0
    overY = t < 0 ? t : t > roomH ? t - roomH : 0
    left = clamp(l, 0, roomW)
    top = clamp(t, 0, roomH)
  }

  // A drag ended: remember the spot. Past an edge by more than half the mic, onto the monitor on that side.
  function dropped() {
    var s = screenObj
    var cx = s.x + reserved[0] + left + overX + size / 2
    var cy = s.y + reserved[1] + top + overY + size / 2
    var to = s
    if (Math.abs(overX) > size / 2 || Math.abs(overY) > size / 2) {
      var list = Quickshell.screens
      for (var i = 0; i < list.length; i++) {
        var o = list[i]
        if (o !== s && cx >= o.x && cx < o.x + o.width && cy >= o.y && cy < o.y + o.height) to = o
      }
    }
    var round = function(v) { return Math.round(v * 1000) / 1000 }
    if (to === s) save({ screen: s.name, x: round(roomW > 0 ? left / roomW : 1), y: round(roomH > 0 ? top / roomH : 0.85) })
    else save({ screen: to.name, x: round(clamp((cx - to.x - size / 2) / Math.max(1, to.width - size), 0, 1)), y: round(clamp((cy - to.y - size / 2) / Math.max(1, to.height - size), 0, 1)) })
    overX = overY = 0
  }

  function toggleTake() {
    bubble = ""
    if (!takeProc.running) takeProc.running = true
  }

  function hideMic() {
    save({ icon: false })
    bubble = ""
    Quickshell.execDetached(["notify-send", "-a", "DICTATE", "DICTATE", "The floating mic is hidden. Phosphor-OS shows it again: SETTINGS > VOICE > FLOATING MIC. Ctrl+Space still dictates."])
  }

  Component.onCompleted: {
    Hyprland.refreshMonitors()
    late.start()
  }
  Timer {
    id: late // the bar may take its room after this plugin starts
    interval: 3000
    onTriggered: Hyprland.refreshMonitors()
  }

  // ---- files

  FileView {
    id: settingsFile
    path: root.home + "/.config/phosphor-os/dictate.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var s = {}
      try { s = JSON.parse(text()) } catch (e) {}
      if (!s || typeof s !== "object" || Array.isArray(s)) s = {}
      s.icon = s.icon !== false
      s.cleanup = s.cleanup === true
      root.settings = s
      root.place()
    }
    onLoadFailed: {
      root.settings = { icon: true, cleanup: false }
      root.place()
    }
  }

  FileView {
    path: root.stateHome + "/phosphor-os/dictate"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var t = text(), i = t.indexOf("\n")
      var word = (i < 0 ? t : t.slice(0, i)).trim() || "idle"
      root.reason = word === "error" && i >= 0 ? t.slice(i + 1).trim().split("\n")[0] : ""
      root.take = word
      root.started = true
    }
    onLoadFailed: root.take = "idle"
  }

  onTakeChanged: {
    if (!started) return
    if (take === "done") {
      flash = "done"
      flashTimer.interval = 1200
      flashTimer.restart()
    } else if (take === "error") {
      flash = "error"
      bubble = "error"
      flashTimer.interval = 4000
      flashTimer.restart()
    } else if (take === "recording") {
      flash = ""
      if (bubble !== "menu") bubble = ""
    }
  }
  Timer {
    id: flashTimer
    onTriggered: {
      root.flash = ""
      if (root.bubble === "error") root.bubble = ""
    }
  }

  // The level, read while listening (a file the take rewrites a few times a second).
  FileView {
    id: levelFile
    path: root.runDir + "/level"
    printErrors: false
    onLoaded: root.level = Math.max(0, Math.min(1, Number(text()) || 0))
    onLoadFailed: root.level = 0
  }
  Timer {
    running: root.listening && win.visible
    interval: 100
    repeat: true
    onTriggered: levelFile.reload()
    onRunningChanged: if (!running) root.level = 0
  }

  Process {
    id: takeProc
    command: ["bash", root.script, "toggle"]
    onExited: (code) => {
      if (code !== 127) return
      root.reason = "INSTALL THE CLOCK"
      root.flash = "error"
      root.bubble = "error"
      flashTimer.interval = 4000
      flashTimer.restart()
    }
  }

  IpcHandler {
    target: "phosphor-os.dictate"

    function show(): void { root.save({ icon: true }) }
    function hide(): void { root.save({ icon: false }) }
    function toggle(): void { root.toggleTake() }
  }

  // ---- the mic

  PanelWindow {
    id: win
    screen: root.screenObj
    visible: root.settings.icon !== false && !!root.screenObj
    anchors { top: true; left: true }
    margins { left: Math.round(root.left); top: Math.round(root.top) }
    exclusiveZone: 0 // takes no room, keeps out of the bar's
    implicitWidth: root.size
    implicitHeight: root.size
    color: "transparent"
    WlrLayershell.namespace: "phosphor-dictate-mic"
    WlrLayershell.layer: WlrLayer.Top
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    mask: Region { item: face } // only the round mic takes clicks

    // Grows with your voice while listening.
    Rectangle {
      anchors.centerIn: face
      width: root.disc
      height: width
      radius: width / 2
      color: "transparent"
      border.color: root.red
      border.width: Math.max(1, Style.space(2))
      visible: root.listening
      scale: 1 + root.level * 0.5
      opacity: 0.3 + root.level * 0.7
      Behavior on scale { NumberAnimation { duration: 90 } }
    }

    Rectangle {
      id: face
      anchors.centerIn: parent
      width: root.disc
      height: width
      radius: width / 2
      color: Util.alpha(root.bg, 0.92)
      border.color: root.listening || root.flash === "error" ? root.red : root.fg
      border.width: Math.max(1, Style.space(2))
      opacity: mouse.containsMouse || root.listening || root.working || root.flash !== "" || root.bubble !== "" ? 1 : 0.75

      // The phosphor glow.
      Rectangle {
        anchors.centerIn: parent
        width: parent.width + Style.space(6)
        height: width
        radius: width / 2
        color: "transparent"
        border.color: Util.alpha(parent.border.color, 0.28)
        border.width: Style.space(3)
      }

      Text {
        anchors.centerIn: parent
        visible: !root.working
        textFormat: Text.PlainText
        // mic, tick, alert (Nerd Font glyphs, as the bar's indicators)
        text: root.flash === "done" ? "󰄬" : root.flash === "error" ? "󰀦" : "󰍬"
        color: root.listening || root.flash === "error" ? root.red : root.fg
        font.family: root.family
        font.pixelSize: Math.round(root.disc * 0.52)
      }

      // Working: an arc that turns (the picture is drawn once; only its rotation moves).
      Canvas {
        id: arc
        anchors.fill: parent
        anchors.margins: Style.space(5)
        visible: root.working
        onVisibleChanged: if (visible) requestPaint()
        onPaint: {
          var c = getContext("2d")
          var w = Math.max(2, Style.space(3))
          c.reset()
          c.strokeStyle = root.fg
          c.lineWidth = w
          c.lineCap = "round"
          c.beginPath()
          c.arc(width / 2, height / 2, width / 2 - w, 0, Math.PI * 1.4)
          c.stroke()
        }
        RotationAnimation on rotation {
          running: root.working
          from: 0
          to: 360
          duration: 900
          loops: Animation.Infinite
        }
      }

      MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        cursorShape: dragging ? Qt.ClosedHandCursor : Qt.PointingHandCursor
        property real px: 0
        property real py: 0
        property bool dragging: false
        // After a move, the next pointer events may still be measured from the old spot: skip them for a moment.
        property bool settling: false

        onPressed: (e) => {
          px = e.x
          py = e.y
          dragging = false
          hintTimer.stop()
          Hyprland.refreshMonitors()
        }
        onPositionChanged: (e) => {
          if (!(e.buttons & Qt.LeftButton) || settling) return
          var dx = e.x - px, dy = e.y - py
          if (!dragging) {
            if (Math.abs(dx) + Math.abs(dy) < Style.space(6)) return
            dragging = true
            if (root.bubble !== "error") root.bubble = ""
          }
          root.moveTo(root.left + dx, root.top + dy)
          settling = true
          settle.restart()
        }
        onReleased: (e) => {
          if (dragging) {
            dragging = false
            root.dropped()
          } else if (e.button === Qt.RightButton) {
            root.bubble = root.bubble === "menu" ? "" : "menu"
          } else if (root.bubble === "menu") {
            root.bubble = ""
          } else {
            root.toggleTake()
          }
        }
        onContainsMouseChanged: {
          if (containsMouse) {
            menuClose.stop()
            if (root.bubble === "" && !root.listening && !root.working) hintTimer.restart()
          } else {
            hintTimer.stop()
            if (root.bubble === "hint") root.bubble = ""
            if (root.bubble === "menu") menuClose.restart()
          }
        }
      }
    }

    Timer {
      id: settle
      interval: 40
      onTriggered: mouse.settling = false
    }
    Timer {
      id: hintTimer
      interval: 700
      onTriggered: if (mouse.containsMouse && root.bubble === "") root.bubble = "hint"
    }
    Timer {
      id: menuClose // the menu goes when the pointer has left the mic and the menu for a moment
      interval: 1500
      onTriggered: if (root.bubble === "menu") root.bubble = ""
    }
  }

  // ---- the box beside the mic: the menu, the hint or the error

  PopupWindow {
    id: pop
    visible: root.bubble !== "" && win.visible
    anchor.window: win
    anchor.rect.x: root.onRight ? (win.width - root.disc) / 2 - Style.space(6) : (win.width + root.disc) / 2 + Style.space(6)
    anchor.rect.y: win.height / 2
    anchor.rect.width: 1
    anchor.rect.height: 1
    anchor.edges: root.onRight ? Edges.Left : Edges.Right
    anchor.gravity: root.onRight ? Edges.Left : Edges.Right
    anchor.adjustment: PopupAdjustment.Flip | PopupAdjustment.Slide
    implicitWidth: box.width
    implicitHeight: box.height
    color: "transparent"

    Rectangle {
      id: box
      readonly property int padX: Style.space(10)
      readonly property int padY: Style.space(7)
      width: content.width + padX * 2
      height: content.height + padY * 2
      color: Util.alpha(root.bg, 0.96)
      border.color: root.bubble === "error" ? root.red : root.fg
      border.width: Math.max(1, Style.space(2))
      radius: Style.cornerRadius

      HoverHandler {
        onHoveredChanged: hovered ? menuClose.stop() : (root.bubble === "menu" && menuClose.restart())
      }

      Column {
        id: content
        x: box.padX
        y: box.padY
        spacing: Style.space(3)

        // the hint and the error: one or a few lines
        Repeater {
          model: root.bubble === "hint"
            ? ["DICTATE IN ANY APP", "Click, talk, click again.", "Ctrl+Space: tap, or hold to talk.", "Right click: options. Drag: move."]
            : root.bubble === "error" ? [root.reason || "FAILED"] : []
          Text {
            required property var modelData
            required property int index
            textFormat: Text.PlainText
            text: modelData
            color: root.bubble === "error" ? root.red : root.fg
            opacity: root.bubble === "hint" && index > 0 ? 0.8 : 1
            font.family: root.family
            font.pixelSize: index === 0 ? Style.font.title : Style.font.body
          }
        }

        // the menu
        Repeater {
          model: root.bubble === "menu"
            ? [{ id: "cleanup", label: "CLEAN UP: " + (root.settings.cleanup ? "ON" : "OFF") },
               { id: "hide", label: "HIDE THE MIC" },
               { id: "open", label: "OPEN PHOSPHOR-OS" }]
            : []
          Rectangle {
            id: row
            required property var modelData
            width: Math.max(label.implicitWidth + Style.space(12), Style.space(170))
            height: label.implicitHeight + Style.space(8)
            color: rowMouse.containsMouse ? root.fg : "transparent"
            Text {
              id: label
              anchors.verticalCenter: parent.verticalCenter
              x: Style.space(6)
              textFormat: Text.PlainText
              text: row.modelData.label
              color: rowMouse.containsMouse ? root.bg : root.fg
              font.family: root.family
              font.pixelSize: Style.font.title
            }
            MouseArea {
              id: rowMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: {
                var id = row.modelData.id
                if (id === "cleanup") root.save({ cleanup: !root.settings.cleanup })
                else if (id === "hide") root.hideMic()
                else {
                  root.bubble = ""
                  Quickshell.execDetached(["bash", root.script, "open"])
                }
              }
            }
          }
        }
      }
    }
  }
}
