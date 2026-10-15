# Moving from Retro Claude to Phosphor-OS

The app was called Retro Claude until 2026-10-12. It is now Phosphor-OS, because it will work with other agents
too (GPT, open models), not only Claude. An install made under the old name keeps working with the new code:

| Old name | New name | How the old one keeps working |
|---|---|---|
| `RETRO_*` settings in `.env` (`RETRO_PASSWORD`, `RETRO_CWD`, `RETRO_PORT`, ...) | `PHOSPHOR_*` | The new name is read first, then the old one (`shared/names.mjs`; bash scripts do the same). Changing the password in the app writes `PHOSPHOR_PASSWORD` and drops the old line. |
| `retro.*` keys in the browser (settings, last tab, launcher, docs, alerts) | `phosphor.*` | The page copies them once on its first load; the old keys stay. |
| `%LOCALAPPDATA%\RetroClaude`, `~/.local/share/RetroClaude`, `~/.local/state/RetroClaude` | `...\PhosphorOS` | The app and the scripts use the old folder while it is the only one there. Nothing moves it by itself (a running app has files open in it); on Linux the migration script moves it. |
| `~/.local/share/fonts/retro-claude` | `fonts/phosphor-os` | `install-fonts.sh` moves it instead of downloading again; `--undo` removes either. |
| `retro-claude-server.service` | `phosphor-os-server.service` | `setup-linux.sh` asks to replace the old unit; `--undo` removes either. |
| Hyprland line marked `-- retro-claude-desktop` | `-- phosphor-os-desktop` | `setup-linux.sh` swaps the line; `--undo` removes either. |
| `retro-claude.desktop`, window class `retro-claude` | `phosphor-os.desktop`, `phosphor-os` | `setup-linux.sh` writes the new entry and removes the old one. |
| Omarchy plugin `retro-claude.screensaver` | `phosphor-os.screensaver` | `desktop.sh` reads the old notes, swaps the folder and the `plugins[]` entry; `--undo` takes back either. |
| MCP server `retro` (`mcp__retro__update_mission`) | `phosphor` (`mcp__phosphor__update_mission`) | HISTORY still shows the mission panel of old chats. |
| Firefox backups `<profile>/retro-claude-backup` | `phosphor-os-backup` | Undo uses the old folder while it is the only one. |

Kept on purpose, because a new name would lose data: the website-pane profile `persist:retro` (site logins), the
passkey user id `retro-claude-owner` (saved passkeys), the docs trash folder `.retro-trash`, the login cookie name.

## Linux

1. Get the new code next to the old folder:
   `git clone https://github.com/CreativLLC/phosphor-os.git ~/phosphor-os`
2. Open a plain terminal (`Super + Alt + T`). Not a chat in the app: the script stops the app and its server.
3. See what it would do: `bash ~/phosphor-os/scripts/migrate-from-retro-claude.sh --dry-run`
4. Do it: `bash ~/phosphor-os/scripts/migrate-from-retro-claude.sh` (old folder elsewhere: `--from DIR`).
   It builds the new folder first, then stops the old app and server, moves `data/` and `.env` over, renames the
   settings in `.env`, moves the per-PC folders, and runs `scripts/setup-linux.sh` (Hyprland line, menu entry,
   server service, the look). Safe to run again.
5. Log out and in. The phone keeps its address and its login (same port, same Tailscale serve, same `data/`).
6. When all works: `rm -rf ~/retro-claude`.

Other things that may still carry the old name and are yours to change: files you named after it yourself (they
keep working), and any notes or Claude memory that point to `~/retro-claude`.

## Windows

Nothing moves by itself; the old `%LOCALAPPDATA%\RetroClaude` folder keeps being used. In order:

1. Quit the app (tray > Quit). Copy the new files over the project folder (keep `data\` and `.env`).
2. Optional, for tidy names: rename `RETRO_` to `PHOSPHOR_` at the start of each line in `.env`. Both work.
3. Run `powershell -ExecutionPolicy Bypass -File scripts\setup-shell.ps1`. It makes the desktop shortcut
   "Phosphor-OS". Delete the old "Retro Claude" shortcut (and unpin the old one from the taskbar, then pin the new).
4. Start the app. If it started with Windows before: tray > Start with Windows, turn it on again, then turn off
   the old "Retro Claude" entry in Task Manager > Startup apps.
5. Optional: to use the new folder name, quit the app and the server, then rename
   `%LOCALAPPDATA%\RetroClaude` to `PhosphorOS`.
6. Windows Terminal schemes: copy `os\windows\terminal-schemes.json` into a `PhosphorOS` fragment folder and pick
   the "Phosphor-OS ..." scheme; delete the old `RetroClaude` fragment folder.

## Phone

Nothing to do. On its first load the page copies its settings to the new names. To show the new name on the home
screen, remove the icon and add it again from the browser menu.
