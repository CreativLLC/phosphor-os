// Phosphor-OS: the notification counter in the bar (not part of Omarchy's plugin). A bell and how many
// notifications wait to be dismissed. Click = show them all as cards above the bar (click again = tuck them
// away); with none waiting, click = the history. Right click = dismiss all. A bell with a slash: DND is on.
// Layout entry in ~/.config/omarchy/shell.json: { "id": "phosphor-os.notifications" }
import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "phosphor-os.notifications"

  // Our own service: the shell routes the built-in id to the clone that replaces it.
  readonly property var service: bar && bar.shell ? bar.shell.firstPartyServiceFor("omarchy.notifications") : null
  readonly property int waiting: service ? service.waitingCount : 0
  readonly property bool dnd: service ? service.doNotDisturb === true : false

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: (root.dnd ? "󰂛" : "󰂚") + (root.waiting > 0 ? " " + root.waiting : "")
    dimmed: root.waiting === 0
    active: root.waiting > 0
    useActiveColor: false
    tooltipText: root.waiting > 0
      ? root.waiting + " waiting. Click: show them. Right click: dismiss all"
      : "No notifications waiting. Click: history"

    onPressed: function(b) {
      if (!root.service) return
      if (b === Qt.RightButton) root.service.clearPopups()
      else if (root.waiting > 0) root.service.setTrayOpen(!root.service.trayOpen)
      else root.service.showRecentHistory()
    }
  }
}
