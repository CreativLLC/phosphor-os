// Phosphor-OS clock: Omarchy's clock with Omarchy's indicators, as one bar widget (not part of Omarchy).
// - Active indicators (recording, DND on, ...) show left of the clock, as Omarchy draws them (Indicators.qml, a
//   copy whose only change is that inactive ones no longer pop out in the bar row).
// - The clock is Omarchy's own, copied into this folder as Clock.qml with Panel.qml and Model.js (the calendar
//   popup; Panel.qml also shows the owner's events, read from the server's calendar.json, see Agenda.js):
//   click = calendar, right click = next format, middle click = time zone; its format settings live in this
//   widget's entry in shell.json.
// - Hover the clock: all the indicator toggles pop up above it, each with what a click does. Move away: they go.
//   The toggles are Omarchy's indicator files, loaded as they are, so their logic stays upstream; dictation is the
//   pack's Dictation.qml (Ctrl+Space in any app, phosphor-dictate).
// The manifest says clonedFrom omarchy.indicators: that is what lets the toggles reach the DND, night light and
// stay-awake services (the shell gives those only to the indicators). Layout entry in shell.json:
// { "id": "phosphor-os.clock", "format": "dddd h:mm AP", ... }
// Night light: a click on its row switches it at the warmth set here (Omarchy's own is a fixed 4000 K); a right
// click opens its options (warmth, schedule). Settings and the schedule: the phosphor-nightlight script next to
// this file (a systemd user timer runs it every minute; desktop.sh installs it).
// DICTATE in any app (Ctrl+Space, phosphor-dictate): while a take runs, a box above the bar on the focused monitor
// says LISTENING (then TYPING) and shows the words heard so far. It never takes clicks or the keyboard.
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import Quickshell.Wayland
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "phosphor-os.clock"

  readonly property var toggleIds: indicators.indicatorEntries.map(function(e) { return indicators.entryId(e) })
  readonly property var clock: clockLoader.item

  // Called for `omarchy-shell omarchy.indicators refresh` and `omarchy-shell omarchy.clock refresh` (both
  // broadcast to this widget on every monitor).
  function refresh() {
    indicators.refresh()
    popupHost.refreshRequested()
    if (root.clock) root.clock.refresh()
  }

  // The calendar, for `omarchy-shell shell toggle phosphor-os.clock` (the bar finds panels by these three).
  readonly property bool opened: root.clock ? root.clock.opened === true : false
  function open() { if (root.clock) root.clock.open() }
  function close() { if (root.clock) root.clock.close() }

  // ---- DICTATE overlay: the state file phosphor-dictate writes (line 1 the state, then the text so far)
  property string dictState: "idle"
  property string dictText: ""
  readonly property bool dictOn: dictState === "recording" || dictState === "transcribing"
  readonly property color dictFg: root.bar ? root.bar.foreground : Color.foreground
  readonly property string dictFont: root.bar ? root.bar.fontFamily : Style.font.family
  // The bar's screen, read here: inside the window it would loop (its screen depends on whether it shows).
  readonly property var dictScreen: root.QsWindow.window ? root.QsWindow.window.screen : null

  FileView {
    path: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/phosphor-os/dictate"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var t = text(), i = t.indexOf("\n")
      root.dictState = (i < 0 ? t : t.slice(0, i)).trim() || "idle"
      root.dictText = i < 0 ? "" : t.slice(i + 1).trim()
    }
    onLoadFailed: root.dictState = "idle"
  }

  PanelWindow {
    id: dictWindow
    // One box: on the monitor you are working on (each bar has this widget, so each monitor has a window).
    screen: root.dictScreen
    visible: root.dictOn && !!root.dictScreen && !!Hyprland.focusedMonitor && Hyprland.focusedMonitor.name === root.dictScreen.name
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "phosphor-dictate"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore
    mask: Region {} // shows only: clicks and keys go to the window under it

    Rectangle {
      id: dictCard
      readonly property int pad: Style.space(14)
      width: Math.min(dictWindow.width * 0.5, Math.max(Style.space(260), dictBody.implicitWidth + pad * 2))
      height: dictHead.height + (dictBody.text ? dictBody.height + Style.space(8) : 0) + pad * 2
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.bottom: parent.bottom
      anchors.bottomMargin: Style.space(67)
      color: Util.alpha(Color.background, 0.95)
      border.color: root.dictFg
      border.width: Math.max(1, Style.space(2))
      radius: Style.cornerRadius

      Row {
        id: dictHead
        x: dictCard.pad
        y: dictCard.pad
        spacing: Style.space(10)
        Rectangle {
          id: dictDot
          width: Style.space(12)
          height: width
          radius: width / 2
          anchors.verticalCenter: parent.verticalCenter
          color: root.dictState === "recording" ? "#ff3b30" : root.dictFg // red = the mic is on, in every theme
          SequentialAnimation on opacity {
            running: dictWindow.visible
            loops: Animation.Infinite
            NumberAnimation { to: 0.25; duration: root.dictState === "recording" ? 600 : 250 }
            NumberAnimation { to: 1; duration: root.dictState === "recording" ? 600 : 250 }
          }
        }
        Text {
          textFormat: Text.PlainText
          text: root.dictState === "recording" ? "LISTENING  (Ctrl+Space to type it)" : "TYPING…"
          color: root.dictFg
          font.family: root.dictFont
          font.pixelSize: Style.font.title
        }
      }
      Text {
        id: dictBody
        x: dictCard.pad
        y: dictHead.y + dictHead.height + Style.space(8)
        width: dictCard.width - dictCard.pad * 2
        textFormat: Text.PlainText
        // The newest words: long takes keep their end in view.
        text: root.dictText.length > 280 ? "…" + root.dictText.slice(-280) : root.dictText
        wrapMode: Text.Wrap
        maximumLineCount: 4
        color: root.dictFg
        opacity: 0.85
        font.family: root.dictFont
        font.pixelSize: Style.font.body
      }
    }
  }

  implicitWidth: layout.implicitWidth
  implicitHeight: layout.implicitHeight

  Grid {
    id: layout
    columns: root.vertical ? 1 : 2
    horizontalItemAlignment: Grid.AlignHCenter
    verticalItemAlignment: Grid.AlignVCenter

    Indicators {
      id: indicators
      bar: root.bar
      moduleName: root.moduleName
      settings: root.settings
    }

    Item {
      id: clockSlot
      implicitWidth: root.clock ? root.clock.implicitWidth : 0
      implicitHeight: root.clock ? root.clock.implicitHeight : root.barSize

      Loader {
        id: clockLoader
        anchors.fill: parent
        source: Qt.resolvedUrl("Clock.qml") // Omarchy's clock, copied so it opens our Panel.qml (the calendar with events)
      }
      // Set after load (Binding, so they follow shell.json): the clock saves its format into our entry.
      Binding { target: root.clock; property: "bar"; value: root.bar; when: !!root.clock }
      Binding { target: root.clock; property: "moduleName"; value: root.moduleName; when: !!root.clock }
      Binding { target: root.clock; property: "settings"; value: root.settings; when: !!root.clock }

      HoverHandler {
        id: clockHover
        onHoveredChanged: hovered ? openTimer.restart() : (openTimer.stop(), closeTimer.restart())
      }
    }
  }

  // ---- the hover popup

  property bool popupOpen: false
  onOpenedChanged: if (opened) popupOpen = false // the calendar took over

  Timer {
    id: openTimer
    interval: 150 // a pass over the clock on the way elsewhere does not open it
    onTriggered: if (clockHover.hovered && !root.opened) { popupHost.refreshRequested(); nlStatusProc.running = true; root.popupOpen = true }
  }
  Timer {
    id: closeTimer
    interval: 300 // time to move from the clock up into the popup
    onTriggered: if (!clockHover.hovered && !popup.containsMouse && !warmthSlider.dragging) root.popupOpen = false
  }
  Connections {
    target: popup
    function onContainsMouseChanged() { if (popup.containsMouse) closeTimer.stop(); else closeTimer.restart() }
  }

  // The indicators in the popup: always revealed (dimmed when off), refreshed with the bar's.
  QtObject {
    id: popupHost
    readonly property bool revealInactiveIndicators: true
    signal refreshRequested()
    function setIndicatorItemHovered(hovered) {}
  }
  // What the bar closes when another popup opens (not the calendar: that is the clock's own).
  QtObject {
    id: popupOwner
    function close() { root.popupOpen = false }
  }

  // ---- night light: warmth and schedule (the options card; settings live in the phosphor-nightlight script)

  readonly property var nightlight: root.bar && root.bar.shell ? root.bar.shell.firstPartyServiceFor("omarchy.nightlight") : null
  readonly property string nlScript: decodeURIComponent(String(Qt.resolvedUrl("phosphor-nightlight")).replace(/^file:\/\//, ""))
  property var nl: ({ warmth: 4000, schedule: "off", from: "21:00", to: "07:00", place: "", coords: false, sunrise: "", sunset: "", allday: "" })
  property bool nlOptions: false // the popup shows the night light options instead of the toggles
  property int nlWarmth: 4000 // what the slider shows (follows a drag before it is saved)
  property var nlTimes: [21, 0, 7, 0] // from h, m, to h, m: edited here, saved a moment after the last click
  property var nlPending: []

  onPopupOpenChanged: if (!popupOpen) nlOptions = false
  onNlChanged: {
    if (!warmthSlider.dragging) nlWarmth = nl.warmth
    if (!nlTimeSave.running) nlTimes = nl.from.split(":").concat(nl.to.split(":")).map(Number)
  }

  // The night light proxy the shell gives a bar widget has no applyTemperature (only setNightlight, at 4000 K):
  // switching and the live preview go through the script, which then tells the service to refresh.
  function nlToggle() { Quickshell.execDetached([root.nlScript, "toggle"]) }
  function nlPreview(k) { Quickshell.execDetached([root.nlScript, "preview", String(k)]) }
  function nlSave(args) { // ["key=value", ...]: saved one run at a time, then the card reads the result
    nlPending = nlPending.concat(args)
    if (!nlSetProc.running) nlFlush()
  }
  function nlFlush() {
    if (!nlPending.length) { nlStatusProc.running = true; return }
    nlSetProc.command = [root.nlScript, "set"].concat(nlPending)
    nlPending = []
    nlSetProc.running = true
  }
  function nlClock(h, m) { return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m }
  function nlStep(i, delta) { // i: 0..3 in nlTimes; hours wrap at 24, minutes at 60 (in steps of 5)
    var t = nlTimes.slice(), span = i % 2 ? 60 : 24
    t[i] = ((t[i] + delta) % span + span) % span
    nlTimes = t
    nlTimeSave.restart()
  }

  Timer {
    id: nlTimeSave
    interval: 700
    onTriggered: root.nlSave(["from=" + root.nlClock(root.nlTimes[0], root.nlTimes[1]), "to=" + root.nlClock(root.nlTimes[2], root.nlTimes[3])])
  }
  Process {
    id: nlSetProc
    onExited: root.nlFlush()
  }
  Process {
    id: nlStatusProc
    command: [root.nlScript, "status"]
    stdout: StdioCollector {
      onStreamFinished: { try { root.nl = JSON.parse(text) } catch (e) {} }
    }
  }
  Component.onCompleted: nlStatusProc.running = true

  PopupCard {
    id: popup
    anchorItem: clockSlot
    bar: root.bar
    owner: popupOwner
    open: root.popupOpen
    triggerMode: "hover"
    contentWidth: popup.fittedContentWidth((root.nlOptions ? nlCard.wantWidth : toggleList.widest) + popup.padding * 2 + Style.space(4))
    contentHeight: popup.fittedContentHeight(root.nlOptions ? nlCard.implicitHeight : toggleList.implicitHeight)

    Column {
      id: toggleList
      visible: !root.nlOptions
      anchors.left: parent.left
      anchors.right: parent.right
      property real widest: Style.space(200) // the longest row so far, so every row is as wide

      Repeater {
        model: root.toggleIds

        Item {
          id: toggleRow
          required property string modelData
          readonly property var toggle: toggleLoader.item
          readonly property bool on: toggle ? toggle.effectiveActive === true : false
          readonly property string fallbackLabel: modelData.replace(/([a-z])([A-Z])/g, "$1 $2")
          readonly property string label: toggle ? ((on ? toggle.activeTooltipText : toggle.inactiveTooltipText) || fallbackLabel) : fallbackLabel
          readonly property bool isNightLight: modelData === "NightLight"

          implicitWidth: toggleLoader.width + labelText.implicitWidth + (isNightLight ? hintText.implicitWidth + Style.space(12) : 0) + Style.space(16)
          implicitHeight: Math.max(toggleLoader.height, labelText.implicitHeight + Style.space(8))
          width: toggleList.width
          onImplicitWidthChanged: toggleList.widest = Math.max(toggleList.widest, implicitWidth)

          Rectangle {
            anchors.fill: parent
            color: root.bar ? root.bar.foreground : Color.foreground
            opacity: rowMouse.containsMouse ? 0.12 : 0
          }

          Loader {
            id: toggleLoader
            anchors.verticalCenter: parent.verticalCenter
            width: item ? item.implicitWidth : 0
            height: item ? item.implicitHeight : 0
            source: indicators.indicatorUrl(toggleRow.modelData)
            onLoaded: {
              item.moduleName = toggleRow.modelData
              item.settings = indicators.entrySettings(indicators.entryForId(toggleRow.modelData))
              item.indicatorHost = popupHost
              item.tooltipText = "" // the label says it; the bar's tooltip cannot point into this popup
            }
          }

          // A binding, not a copy in onLoaded: the rows load before the bar hands this widget its `bar`, and a
          // toggle without one does nothing (night light, DND, stay awake, recording and dictation all need it).
          Binding { target: toggleLoader.item; property: "bar"; value: root.bar; when: !!toggleLoader.item }

          Text {
            id: labelText
            textFormat: Text.PlainText
            anchors.left: toggleLoader.right
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: toggleRow.label
            color: root.bar ? root.bar.foreground : Color.foreground
            opacity: toggleRow.on ? 1 : 0.7
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
          }

          Text {
            id: hintText
            visible: toggleRow.isNightLight
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            text: "right click: options"
            color: root.bar ? root.bar.foreground : Color.foreground
            opacity: 0.5
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.caption
          }

          // The whole row is the button (the icon's own click area stays on top of it). Night light: the row takes
          // the icon's clicks too, so a click uses the warmth set here and a right click opens the options.
          MouseArea {
            id: rowMouse
            anchors.fill: parent
            z: toggleRow.isNightLight ? 1 : -1
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
            onClicked: function(mouse) {
              if (!toggleRow.isNightLight) { if (toggleRow.toggle) toggleRow.toggle.triggerPress(mouse.button) }
              else if (mouse.button === Qt.RightButton) { nlStatusProc.running = true; root.nlOptions = true }
              else if (mouse.button === Qt.LeftButton) root.nlToggle()
            }
          }
        }
      }
    }

    // The night light options (right click on its row): warmth and schedule. Mouse only: a hover popup gets no
    // keyboard, so the times are numbers you click or scroll.
    Column {
      id: nlCard
      visible: root.nlOptions
      anchors.left: parent.left
      anchors.right: parent.right
      spacing: Style.space(8)
      readonly property real wantWidth: Math.max(scheduleChoice.implicitWidth, Style.space(300))

      readonly property color fg: root.bar ? root.bar.foreground : Color.foreground
      readonly property string face: root.bar ? root.bar.fontFamily : Style.font.family
      readonly property bool lightOn: root.nightlight ? root.nightlight.enabled === true : false

      Text {
        textFormat: Text.PlainText
        text: "< Night light: " + (nlCard.lightOn ? "on" : "off")
        color: nlCard.fg
        font.family: nlCard.face
        font.pixelSize: Style.font.body
        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.nlOptions = false
        }
      }

      Text {
        textFormat: Text.PlainText
        text: "Warmth: " + root.nlWarmth + " K" + (nlCard.lightOn ? "" : " (try it: switch night light on)")
        color: nlCard.fg
        font.family: nlCard.face
        font.pixelSize: Style.font.body
      }
      PanelSlider {
        id: warmthSlider
        bar: root.bar
        width: parent.width
        minimum: 2500
        maximum: 5900
        step: 100
        value: root.nlWarmth
        onMoved: function(v) {
          var k = Math.round(v / 100) * 100
          if (k === root.nlWarmth) return
          root.nlWarmth = k
          if (nlCard.lightOn) root.nlPreview(k) // live on screen
        }
        onReleased: function(v) {
          if (nlCard.lightOn) root.nlPreview(root.nlWarmth)
          root.nlSave(["warmth=" + root.nlWarmth])
        }
        onDraggingChanged: if (!dragging && !popup.containsMouse && !clockHover.hovered) closeTimer.restart()
      }
      Item {
        width: parent.width
        implicitHeight: warmerText.implicitHeight
        Text { id: warmerText; text: "warmer"; color: nlCard.fg; opacity: 0.6; font.family: nlCard.face; font.pixelSize: Style.font.caption }
        Text { anchors.right: parent.right; text: "barely"; color: nlCard.fg; opacity: 0.6; font.family: nlCard.face; font.pixelSize: Style.font.caption }
      }

      Text {
        textFormat: Text.PlainText
        text: "Schedule"
        color: nlCard.fg
        font.family: nlCard.face
        font.pixelSize: Style.font.body
      }
      ButtonGroup {
        id: scheduleChoice
        options: [{ value: "off", label: "Off" }, { value: "fixed", label: "Fixed times" }, { value: "sun", label: "Sundown to sunup" }]
        value: root.nl.schedule
        focusable: false
        foreground: nlCard.fg
        background: root.bar ? root.bar.background : Color.background
        fontFamily: nlCard.face
        onChanged: function(v) {
          root.nl = Object.assign({}, root.nl, { schedule: v })
          root.nlSave(["schedule=" + v])
        }
      }

      Row {
        visible: root.nl.schedule === "fixed"
        spacing: Style.space(6)
        Text { anchors.verticalCenter: parent.verticalCenter; text: "From"; color: nlCard.fg; font.family: nlCard.face; font.pixelSize: Style.font.body }
        TimeBox { host: root; slot: 0 }
        Text { anchors.verticalCenter: parent.verticalCenter; text: ":"; color: nlCard.fg; font.family: nlCard.face; font.pixelSize: Style.font.body }
        TimeBox { host: root; slot: 1 }
        Text { anchors.verticalCenter: parent.verticalCenter; text: "  to"; color: nlCard.fg; font.family: nlCard.face; font.pixelSize: Style.font.body }
        TimeBox { host: root; slot: 2 }
        Text { anchors.verticalCenter: parent.verticalCenter; text: ":"; color: nlCard.fg; font.family: nlCard.face; font.pixelSize: Style.font.body }
        TimeBox { host: root; slot: 3 }
      }
      Text {
        width: parent.width
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
        color: nlCard.fg
        opacity: 0.7
        font.family: nlCard.face
        font.pixelSize: Style.font.caption
        text: {
          var n = root.nl
          if (n.schedule === "fixed") return "Click a number for more, right click for less, or scroll it."
          if (n.schedule === "off") return "Night light changes only when you click it."
          if (!n.coords) return (n.place ? "The weather place (" + n.place + ") has no map position." : "No weather place is saved.")
            + " Click the weather in the bar, click the place name and pick a place from the list."
          if (n.allday === "night") return "The sun stays down today: night light all day."
          if (n.allday === "day") return "The sun stays up today: no night light."
          return "Sunset " + n.sunset + ", sunrise " + n.sunrise + (n.place ? " (" + n.place + ")." : ".")
        }
      }
      Text {
        width: parent.width
        wrapMode: Text.WordWrap
        visible: root.nl.schedule !== "off"
        textFormat: Text.PlainText
        color: nlCard.fg
        opacity: 0.7
        font.family: nlCard.face
        font.pixelSize: Style.font.caption
        text: "A click on night light still works; the schedule switches again at its next edge."
      }
    }
  }

  // An hour or a minute of the night light schedule (slot 0..3: from hour, from minute, to hour, to minute).
  component TimeBox: Rectangle {
    id: box
    property var host: null
    property int slot: 0
    readonly property color fg: host && host.bar ? host.bar.foreground : Color.foreground
    readonly property int amount: host ? host.nlTimes[slot] : 0
    readonly property int step: slot % 2 ? 5 : 1
    implicitWidth: boxText.implicitWidth + Style.space(14)
    implicitHeight: boxText.implicitHeight + Style.space(6)
    radius: Style.cornerRadius
    color: Qt.rgba(fg.r, fg.g, fg.b, boxMouse.containsMouse ? 0.18 : 0.06)
    border.width: Math.max(1, Style.space(1))
    border.color: fg

    Text {
      id: boxText
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: (box.amount < 10 ? "0" : "") + box.amount
      color: box.fg
      font.family: box.host && box.host.bar ? box.host.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.body
    }
    MouseArea {
      id: boxMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      onClicked: function(mouse) { box.host.nlStep(box.slot, mouse.button === Qt.RightButton ? -box.step : box.step) }
      onWheel: function(wheel) { box.host.nlStep(box.slot, wheel.angleDelta.y > 0 ? box.step : -box.step) }
    }
  }
}
