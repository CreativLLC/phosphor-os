// Retro Claude screensaver: a ship's computer readout drawn over Omarchy's own screensaver, in the active
// theme's colors and the Omarchy font (VT323 with the pack). Big clock, date, blinking cursor, a slow scan line.
// Omarchy still does the rest: idle timing, the screensaver window (class org.omarchy.screensaver, which the
// idle service tracks), the screensaver-off toggle, and the exit on any key (the key reaches that window,
// this layer never takes the keyboard). Added here: a mouse move, click or scroll ends it too.
// Turned on by { "id": "retro-claude.screensaver" } in plugins[] of ~/.config/omarchy/shell.json.
import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

Scope {
  id: root

  readonly property string saverClass: "org.omarchy.screensaver"
  readonly property var savers: ToplevelManager.toplevels.values.filter(t => t.appId === saverClass)
  readonly property bool on: savers.length > 0

  property color fg: "#ffb000"
  property color bg: "#0b0700"
  property color dim: "#b07c08"
  property color bright: "#ffd68a"
  property date now: new Date()
  property bool blink: false
  property real shownAt: 0

  function readColors(text) {
    const get = k => (text.match(new RegExp("^" + k + "\\s*=\\s*\"(#[0-9a-fA-F]{6})\"", "m")) || [])[1]
    fg = get("foreground") || fg
    bg = get("background") || bg
    dim = get("dark_foreground") || get("muted") || Qt.darker(fg, 1.6)
    bright = get("bright_foreground") || get("accent") || fg
  }

  // Closing Omarchy's windows is its own exit path: the window's script restores the cursor.
  function wake() {
    for (const t of savers) t.close()
  }

  onOnChanged: if (on) {
    shownAt = Date.now()
    now = new Date()
    colors.reload()
  }

  FileView {
    id: colors
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    printErrors: false
    onLoaded: root.readColors(text())
  }

  Timer {
    running: root.on
    repeat: true
    interval: 500
    onTriggered: {
      root.now = new Date()
      root.blink = !root.blink
    }
  }

  Variants {
    model: root.on ? Quickshell.screens : []

    PanelWindow {
      id: win
      required property var modelData
      screen: modelData
      anchors { top: true; bottom: true; left: true; right: true }
      exclusionMode: ExclusionMode.Ignore
      color: root.bg
      WlrLayershell.layer: WlrLayer.Overlay
      WlrLayershell.namespace: "retro-claude-screensaver"
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

      readonly property real unit: Math.min(width, height)
      readonly property int big: Math.round(Math.min(width * 0.16, height * 0.26))
      readonly property int small: Math.max(16, Math.round(big * 0.2))
      property real drift

      // Moves the readout a little, so nothing sits still on the screen for hours.
      SequentialAnimation on drift {
        loops: Animation.Infinite
        NumberAnimation { to: 1; duration: 37000; easing.type: Easing.InOutSine }
        NumberAnimation { to: -1; duration: 37000; easing.type: Easing.InOutSine }
      }

      Item {
        id: readout
        width: frame.width
        height: frame.height
        x: (win.width - width) / 2 + win.drift * win.width * 0.03
        y: (win.height - height) / 2 - win.drift * win.height * 0.02
        layer.enabled: true
        layer.effect: MultiEffect {
          shadowEnabled: true
          shadowColor: root.fg
          shadowBlur: 0.5
          shadowOpacity: 0.6
          shadowHorizontalOffset: 0
          shadowVerticalOffset: 0
        }

        Rectangle {
          id: frame
          width: Math.max(body.width, title.implicitWidth) + win.small * 3
          height: head.height + body.height + win.small * 1.2
          color: "transparent"
          border.color: root.dim
          border.width: Math.max(2, Math.round(win.unit / 400))

          Rectangle {
            id: head
            width: parent.width
            height: win.small * 1.6
            color: root.dim
            Text {
              id: title
              anchors.centerIn: parent
              text: "RETRO CLAUDE // SHIP'S COMPUTER"
              color: root.bg
              font.family: "monospace"
              font.pixelSize: win.small
            }
          }

          Column {
            id: body
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: head.bottom
            anchors.topMargin: win.small * 0.6
            spacing: win.small * 0.3

            Row {
              anchors.horizontalCenter: parent.horizontalCenter
              Repeater {
                model: [Qt.formatTime(root.now, "HH"), ":", Qt.formatTime(root.now, "mm")]
                Text {
                  required property string modelData
                  text: modelData
                  color: root.fg
                  opacity: modelData === ":" && root.now.getSeconds() % 2 ? 0.25 : 1
                  font.family: "monospace"
                  font.pixelSize: win.big
                }
              }
            }
            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: Qt.formatDate(root.now, "ddd d MMM yyyy").toUpperCase()
              color: root.dim
              font.family: "monospace"
              font.pixelSize: win.small
            }
            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: "ALL SYSTEMS NOMINAL. SHIP ON STANDBY."
              color: root.bright
              font.family: "monospace"
              font.pixelSize: win.small
            }
            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: "PRESS ANY KEY " + (root.blink ? "\u2588" : "\u2003")
              color: root.dim
              font.family: "monospace"
              font.pixelSize: Math.round(win.small * 0.8)
            }
          }
        }
      }

      // Phosphor scan lines, drawn once.
      Canvas {
        anchors.fill: parent
        opacity: 0.18
        onPaint: {
          const g = getContext("2d")
          g.clearRect(0, 0, width, height)
          g.fillStyle = "#000000"
          for (let y = 0; y < height; y += 4) g.fillRect(0, y, width, 2)
        }
      }

      // The slow scan line: a faint band of light rolling down the tube.
      Rectangle {
        width: parent.width
        height: parent.height * 0.12
        gradient: Gradient {
          GradientStop { position: 0; color: "transparent" }
          GradientStop { position: 0.8; color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.07) }
          GradientStop { position: 1; color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.14) }
        }
        NumberAnimation on y {
          from: -win.height * 0.12
          to: win.height
          duration: 7000
          loops: Animation.Infinite
        }
      }

      // A real mouse move (past a little jitter, after the first moment), a click or a scroll wakes it.
      MouseArea {
        property point first: Qt.point(-1, -1)
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.BlankCursor
        acceptedButtons: Qt.AllButtons
        onPressed: root.wake()
        onWheel: root.wake()
        onPositionChanged: mouse => {
          if (Date.now() - root.shownAt < 800) return
          if (first.x < 0) first = Qt.point(mouse.x, mouse.y)
          else if (Math.hypot(mouse.x - first.x, mouse.y - first.y) >= 8) root.wake()
        }
      }
    }
  }
}
