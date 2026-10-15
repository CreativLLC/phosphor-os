// Phosphor-OS taskbar: the open windows of the workspace shown on this bar's monitor, as buttons
// (small icon + name) in the Omarchy bar. Each monitor's bar lists its own workspace.
// Click = bring that window to the front (Hyprland goes to its workspace; the window takes over the
// maximized slot); click the window already in front = minimize it. Right click = minimize. Middle click = close.
// Minimized = parked on the hidden workspace special:minimized (Super + M too). Its button stays on every bar,
// dimmed; click it, or anything that focuses it (a notification click, Alt + Tab), brings it back here.
// Notifications: an app with unread notifications (or that asks for attention) gets a red dot; a red-dot MSG
// button in front shows there are any (click = Omarchy's notification history). The dot clears once you stay on
// the app for 2 s (Omarchy focuses windows on mouse-over, so a pass with the mouse does not count) or click it.
// Layout entry in ~/.config/omarchy/shell.json: { "id": "taskbar", "type": "qml" }
import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io

Item {
  id: root
  property var bar
  property string moduleName
  property var settings

  readonly property color fg: bar ? bar.foreground : "#ffb000"
  readonly property color bg: bar ? bar.background : "#000000"
  readonly property int size: bar ? bar.barSize : 26
  readonly property int maxLabel: 16
  readonly property string minimizedName: "special:minimized"
  // The workspace on this bar's monitor right now (-1 when unknown: then every window shows).
  readonly property var monitor: QsWindow.window && QsWindow.window.screen ? Hyprland.monitorFor(QsWindow.window.screen) : null
  readonly property int workspaceId: monitor && monitor.activeWorkspace ? monitor.activeWorkspace.id : -1

  function classOf(t) {
    var ipc = t.lastIpcObject || {}
    return String(ipc.class || (t.wayland ? t.wayland.appId : "") || "")
  }

  function entryOf(t) {
    var id = classOf(t)
    if (!id) return null
    // Omarchy web apps (chrome-discord.com__...): their menu entry has the site's name (Discord).
    var web = id.match(/^chrome-(?:www\.)?([^._]+)\./)
    if (web) {
      var apps = DesktopEntries.applications.values
      for (var i = 0; i < apps.length; i++) {
        if (String(apps[i].name).toLowerCase() === web[1].toLowerCase()) return apps[i]
      }
    }
    return DesktopEntries.heuristicLookup(id)
  }

  // A short, readable name for a window.
  function nameOf(t) {
    var id = classOf(t)
    if (id === "phosphor-os") return "CLAUDE"
    // Chromium web apps: chrome-discord.com__channels_@me-Default -> DISCORD
    var web = id.match(/^chrome-(?:www\.)?([^._]+)\./)
    if (web) return web[1].toUpperCase()
    var entry = entryOf(t)
    // Reverse-DNS ids without a desktop entry (org.omarchy.agent): keep the last part.
    var name = entry && entry.name ? entry.name : (id ? id.split(".").pop() : (t.title || "?"))
    name = String(name).toUpperCase()
    return name.length > maxLabel ? name.slice(0, maxLabel - 1) + "…" : name
  }

  // Where to look for a window's icon, best first. The icon theme (Yaru) lacks some apps (Firefox, Discord),
  // so the plain hicolor and pixmaps files come next. The button tries them in order until one loads.
  function iconsOf(t) {
    var entry = entryOf(t)
    var name = entry && entry.icon ? entry.icon : classOf(t)
    if (!name) return []
    if (name.indexOf("/") === 0) return ["file://" + name]
    var list = []
    var themed = Quickshell.iconPath(name, true)
    if (themed) list.push(themed)
    var sizes = ["48x48", "64x64", "128x128", "256x256", "32x32"]
    for (var i = 0; i < sizes.length; i++) list.push("file:///usr/share/icons/hicolor/" + sizes[i] + "/apps/" + name + ".png")
    list.push("file:///usr/share/icons/hicolor/scalable/apps/" + name + ".svg")
    list.push("file:///usr/share/pixmaps/" + name + ".png")
    return list
  }

  // Only real app windows: Steam and others open hidden helper windows ("Steam SDL Dummy", "Untitled",
  // steamwebhelper) that cannot be switched to; the screensaver is not an app either.
  function isMinimized(t) {
    return !!t.workspace && t.workspace.name === minimizedName
  }

  function isApp(t) {
    var ipc = t.lastIpcObject || {}
    if (ipc.mapped === false || ipc.hidden === true) return false
    var title = String(t.title || "")
    var id = classOf(t)
    if (!title || !id) return false
    if (/^(steamwebhelper|steam_proton|org\.omarchy\.screensaver|phosphor-os-screensaver)$/i.test(id)) return false
    if (/^(Steam SDL Dummy|Untitled)$/i.test(title)) return false
    if (root.workspaceId >= 0 && t.workspace && t.workspace.id !== root.workspaceId && !isMinimized(t)) return false
    return true
  }

  function addressOf(t) {
    var addr = String(t.address || "")
    if (addr && addr.indexOf("0x") !== 0) addr = "0x" + addr
    return /^0x[0-9a-fA-F]+$/.test(addr) ? addr : "" // hex only, so it is safe inside the Lua strings below
  }

  // argv, no shell: nothing in a title or address can be read as a command.
  function dispatch(lua) {
    Quickshell.execDetached(["hyprctl", "dispatch", lua])
  }

  function switchTo(t) {
    var addr = addressOf(t)
    if (!addr) {
      if (t.wayland) t.wayland.activate()
      return
    }
    if (isMinimized(t)) return restore(t)
    dispatch("hl.dsp.focus({ window = \"address:" + addr + "\" })")
  }

  function minimize(t) {
    var addr = addressOf(t)
    if (addr) dispatch("hl.dsp.window.move({ workspace = \"" + minimizedName + "\", follow = false, window = \"address:" + addr + "\" })")
  }

  // Back onto the workspace this bar shows, in front.
  function restore(t) {
    var addr = addressOf(t)
    if (!addr || root.workspaceId < 0) return
    dispatch("hl.dsp.window.move({ workspace = \"" + root.workspaceId + "\", window = \"address:" + addr + "\" })")
    dispatch("hl.dsp.focus({ window = \"address:" + addr + "\" })")
  }

  // ---- notifications. Bar add-ons get no access to Omarchy's notification service (by design), but Omarchy
  // saves each new pop-up as <ts>-<id>.json in ~/.local/state/omarchy/notifications/: watch that folder and read
  // the sender (`app`). Files restored after a shell restart are not new, so they do not count.
  readonly property real loadedAt: Date.now() // pop-ups older than this bar are not new
  property var unread: ({}) // lower-case app name -> count (replaced, never mutated, so bindings update)
  readonly property int unreadTotal: {
    var n = 0
    for (var k in unread) n += unread[k]
    return n
  }

  // Does notification sender `key` (its app name) belong to window t?
  function sentBy(key, t) {
    var cls = classOf(t).toLowerCase()
    return key === cls || key === nameOf(t).toLowerCase() || (key.length > 2 && cls.indexOf(key) !== -1)
  }

  function unreadFor(t) {
    var n = 0
    for (var k in unread) if (sentBy(k, t)) n += unread[k]
    return n
  }

  function clearUnreadFor(t) {
    var next = {}, changed = false
    for (var k in unread) {
      if (sentBy(k, t)) changed = true
      else next[k] = unread[k]
    }
    if (changed) unread = next
  }

  function countNotification(app) {
    app = String(app || "").trim().toLowerCase()
    if (!app || app === "notify-send" || app === "omarchy-action") return // not app messages
    var next = Object.assign({}, root.unread)
    next[app] = (next[app] || 0) + 1
    root.unread = next
  }

  // inotifywait runs as the Process itself (no shell in between), so it stops with the bar. A bash pipeline
  // here outlived each `omarchy restart shell` and left the new bar without a watcher.
  readonly property string popupDir: Quickshell.env("HOME") + "/.local/state/omarchy/notifications"
  FileView { id: popupFile; blockLoading: true }
  property var seenPopups: ({})
  Process {
    running: true
    command: ["inotifywait", "-mq", "-e", "close_write", "--format", "%f", root.popupDir]
    stdout: SplitParser {
      onRead: function(name) {
        // A pop-up that changes in place (same file) counts once.
        if (!/^[0-9]+-[0-9]+\.json$/.test(name) || root.seenPopups[name]) return
        root.seenPopups[name] = true
        popupFile.path = root.popupDir + "/" + name
        popupFile.reload() // a new path can still hand back the last file's text; read this one now
        try {
          var e = JSON.parse(popupFile.text())
          // On start Omarchy writes back the pop-ups still on screen: those are not new.
          if (Number(e.timestamp) >= root.loadedAt) root.countNotification(e.app)
        } catch (err) {}
      }
    }
  }

  readonly property color dotColor: "#e5484d" // red, in every theme
  // The window that just got focus; its dot clears if it keeps focus for a moment.
  property var dwellOn: null
  Timer {
    id: dwell
    interval: 2000
    onTriggered: if (root.dwellOn && Hyprland.activeToplevel === root.dwellOn) root.clearUnreadFor(root.dwellOn)
  }

  readonly property bool anyUrgent: {
    var list = Hyprland.toplevels.values
    for (var i = 0; i < list.length; i++) if (list[i].urgent) return true
    return false
  }

  // Something focused a minimized window (notification click, Alt + Tab): bring it back instead of opening the
  // hidden workspace. Only the bar on the focused monitor acts.
  Connections {
    target: Hyprland
    function onActiveToplevelChanged() {
      var t = Hyprland.activeToplevel
      if (!t) return
      root.dwellOn = t
      dwell.restart()
      if (root.isMinimized(t) && root.monitor && root.monitor === Hyprland.focusedMonitor) root.restore(t)
    }
  }

  implicitWidth: row.implicitWidth
  implicitHeight: size

  Row {
    id: row
    anchors.verticalCenter: parent.verticalCenter
    spacing: 4

    // MSG with a red dot: there are unread notifications. Click = Omarchy's notification history (clears the dots).
    Rectangle {
      visible: root.unreadTotal > 0
      height: root.size - 6
      width: visible ? msgRow.implicitWidth + 14 : 0
      color: "transparent"
      border.width: 1
      border.color: root.fg

      Row {
        id: msgRow
        anchors.centerIn: parent
        spacing: 5
        Rectangle { width: 8; height: 8; radius: 4; color: root.dotColor; anchors.verticalCenter: parent.verticalCenter }
        Text {
          text: "MSG"
          color: root.fg
          font.family: root.bar ? root.bar.fontFamily : "monospace"
          font.pixelSize: 16
          anchors.verticalCenter: parent.verticalCenter
        }
      }

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: {
          root.unread = ({})
          Quickshell.execDetached(["omarchy-shell", "notifications", "showHistory"])
        }
      }
    }

    Repeater {
      model: Hyprland.toplevels

      Rectangle {
        id: btn
        required property var modelData
        readonly property bool active: modelData.activated
        readonly property bool hovered: mouse.containsMouse
        readonly property var icons: root.iconsOf(modelData)
        property int iconTry: 0

        readonly property bool minimized: root.isMinimized(modelData)
        readonly property int unread: root.unreadFor(modelData)
        // Red dot: unread notifications from this app, or the app asks for attention (urgent).
        readonly property bool calling: !active && (unread > 0 || modelData.urgent === true)

        visible: root.isApp(modelData)
        height: root.size - 6
        width: visible ? content.implicitWidth + 14 : 0
        color: active ? root.fg : "transparent"
        border.width: 1
        border.color: hovered || active ? root.fg : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, minimized ? 0.2 : 0.35)

        Row {
          id: content
          anchors.centerIn: parent
          opacity: btn.minimized ? 0.45 : 1 // dim when minimized; the red dot stays bright
          spacing: 5

          Image {
            visible: status === Image.Ready
            source: btn.iconTry < btn.icons.length ? btn.icons[btn.iconTry] : ""
            onStatusChanged: if (status === Image.Error) Qt.callLater(function() { btn.iconTry++ })
            width: 14
            height: 14
            sourceSize.width: 28
            sourceSize.height: 28
            anchors.verticalCenter: parent.verticalCenter
          }

          Text {
            text: root.nameOf(btn.modelData)
            textFormat: Text.PlainText
            color: btn.active ? root.bg : root.fg
            font.family: root.bar ? root.bar.fontFamily : "monospace"
            font.pixelSize: 16
            font.bold: btn.active
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        Rectangle {
          visible: btn.calling
          width: 8
          height: 8
          radius: 4
          color: root.dotColor
          anchors.top: parent.top
          anchors.right: parent.right
          anchors.margins: 2
        }

        MouseArea {
          id: mouse
          anchors.fill: parent
          hoverEnabled: true
          acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
          cursorShape: Qt.PointingHandCursor
          onClicked: function(m) {
            if (m.button === Qt.MiddleButton) {
              if (btn.modelData.wayland) btn.modelData.wayland.close()
            } else if (m.button === Qt.RightButton || (btn.active && !btn.minimized)) {
              root.minimize(btn.modelData)
            } else {
              root.clearUnreadFor(btn.modelData) // a click on the button counts as "seen" at once
              root.switchTo(btn.modelData)
            }
          }
          onEntered: if (root.bar) root.bar.showTooltip(btn, btn.modelData.title || root.classOf(btn.modelData))
          onExited: if (root.bar) root.bar.hideTooltip(btn)
        }
      }
    }
  }
}
