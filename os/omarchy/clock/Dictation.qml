// Phosphor-OS: Omarchy 4.0.4's plugins/bar/indicators/Dictation.qml (MIT), changed to show Phosphor-OS DICTATE
// (Super+H in any app, the phosphor-dictate script next to this file) instead of voxtype. The state comes from
// the one-word file the script writes; a click starts or stops a take like Super+H.
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

BarIndicator {
  id: root

  property string state: "idle"
  readonly property string script: decodeURIComponent(String(Qt.resolvedUrl("phosphor-dictate")).replace(/^file:\/\//, ""))
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")

  active: state === "recording" || state === "transcribing"
  activeText: state === "transcribing" ? "󰔟" : "󰍬"
  inactiveText: "󰍬"
  activeTooltipText: state === "transcribing" ? "Typing what you said…" : "Listening: Super+H or click to type it"
  inactiveTooltipText: "Dictate in any app (Super+H)"

  FileView {
    path: root.stateHome + "/phosphor-os/dictate"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.state = text().split("\n")[0].trim() || "idle" // line 1; the rest is the text so far
    onLoadFailed: root.state = "idle"
  }

  onPressed: function() { Quickshell.execDetached([root.script, "toggle"]) }
}
