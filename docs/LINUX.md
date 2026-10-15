# Phosphor-OS on Linux (Omarchy 4.0.4)

The safety-net keys and `--undo` are there if a step goes wrong.
Every change to Omarchy, and how to undo it: `docs/OMARCHY.md`.
Installed under the old name (Retro Claude, `~/retro-claude`)? Move it over with `docs/MIGRATE.md`.

## Install steps (on a fresh Omarchy)

1. **Wi-Fi and updates.** Wi-Fi: `Super + Ctrl + W` (or plug in a cable). Updates: `Super + Space` > Update > Omarchy.
2. **Apps first** (optional; the app adds its Web and Discord buttons on its first start, only for apps it finds):
   `Super + Space` > Install > Package: `firefox`, `discord`.
3. **Claude Code login.** Open a terminal (`Super + Return`), run `claude`, log in, then quit it.
4. **Tailscale login** (optional, for the phone). `Super + Space` > Install > Service > Tailscale (Omarchy runs
   `tailscale up` and lets your user manage it).
5. **Get the app into a local folder.** `git clone https://github.com/CreativLLC/phosphor-os.git ~/phosphor-os`.
   Keep it out of any folder a sync client (Nextcloud, Dropbox...) syncs to other PCs: setup fills it with Linux
   files (node_modules, data, .env) that would break a copy on Windows. Moving from another install and want the
   same app password? Copy its `.env` to `~/phosphor-os/.env` (`PHOSPHOR_PASSWORD`, or `RETRO_PASSWORD` from before
   the rename: both work).
6. **Run the setup.** `bash ~/phosphor-os/scripts/setup-linux.sh`
   It asks for the workspace folder (the folder Claude works in, for example `~/workspace`), asks before anything
   that needs sudo, and can be run again safely. `--dry-run` first shows every step without doing it.
   It installs: Node 24 (mise), packages and the page, the voice engine (0.7 GB), Electron (300 MB),
   the server as a service, Tailscale serve (private to your tailnet, never funnel), desktop mode, and the
   look (theme `retro-amber`, font VT323, the bar at the bottom with a taskbar). Another look: `--theme lcars`
   or `--theme retro-green`.
7. **Reboot** (or log out and in). Phosphor-OS starts maximized on workspace 1, under the bar. Log in with the password in
   `~/phosphor-os/.env` (a new one is made on the first start).
8. **Phone.** Open the address that `tailscale serve status` shows, log in, add it to the home screen.
   Fingerprint login is per address: add it again after the PC's tailnet name changes.

## Keys

| Key | What it does |
|---|---|
| `Super + Space` | Open apps (Omarchy's menu). Type "doc" for Phosphor Docs: the app on DOCS |
| `Super + Alt + R` | Restart Phosphor-OS (the server and running chats keep going) |
| `Super + Alt + T` | A plain terminal. The safety net: works even when Phosphor-OS does not |
| `Super + T` | The window to full size, under the bar |
| `Super + F` | Real full screen, over the bar (games, video) |
| `Super + Shift + T` | Floating on or off |
| `Super + Space` | Omarchy's menu (still there) |
| `Super + Return` | Omarchy's terminal |
| `Super + Shift + Space` | Hide or show the bar |
| `Super + 1` to `Super + 9` | Workspaces; Phosphor-OS lives on 1 |

The bar is always on, at the bottom. Its taskbar shows every open window: click = to the front, middle
click = close.
If the whole screen hangs: `Ctrl + Alt + F2` gives a text login; log in and run the undo below.

## Updating the app

Get the new files (`git -C ~/phosphor-os pull`, or your `rsync`), then run `bash ~/phosphor-os/scripts/setup-linux.sh`
again (it rebuilds the page). New server code loads at the next server restart:
`systemctl --user restart phosphor-os-server` (this cuts off a reply in progress; wait until Claude is idle).
Server log: `~/phosphor-os/data/server.log`.

## Undo

`bash ~/phosphor-os/scripts/setup-linux.sh --undo`, then log out and in. It takes back the look (theme, font,
bar, taskbar; see `docs/OMARCHY.md`), takes out the one line it added to `~/.config/hypr/hyprland.lua` (a backup
of the original sits next to it), shows the bar again if an older version hid it, and asks before
removing the server service, Tailscale serve, Electron and the voice engine. It leaves Node, the app folder, its
`.env` and its data alone.

## Dual boot with Windows

Windows and Linux read the PC clock differently, so the time can be off by hours after switching.
One fix on Linux: `timedatectl set-local-rtc 1`.

## What is untested

- `os/omarchy/desktop.sh` (the look) and its `--undo` ran only in a test home with stand-in commands. On the
  author's PC the same settings were first made by hand.
  Hyprland's code says a bind that already fired with Super held cancels it; a Super + mouse drag may not.
- The window class `phosphor-os`, the maximize rule, and that Firefox or Discord opened from the app show up
  in front of it.
- The Super key takes about 1 s to open the launcher on Windows (a second app start hands it over); Linux unknown.
- The voice engine on Linux (the addon's own files say it finds its libraries itself; not run).
