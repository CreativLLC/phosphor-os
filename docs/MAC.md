# Phosphor-OS on a Mac (app only)

**Untested on a real Mac.** The code has Mac support, but nobody has run it there yet. Read this file to the end before you start. If a step fails, fix it in the repo (the script or the code), not only on the Mac, and record the fix here.

What works on a Mac: the app window, chats with Claude, DOCS, HISTORY, DICTATE (inside the app), the phone over Tailscale. What does not: the desktop look and everything in `os/` (Omarchy, Linux only), the local chat models and the local image model (their setup scripts are for an AMD card on Linux; see the end of this file).

Needs: an Apple Silicon Mac (M1 or later), macOS 13 or later, [Homebrew](https://brew.sh), about 2 GB of disk (Node packages, Electron, the speech model).

## For Claude Code on the Mac

You are setting this up for the owner. Do the steps in order. Say what each step did. Ask before anything that is hard to undo. The rules in the repo's `CLAUDE.md` apply here too (never print `.env`, never `tailscale funnel`, the server listens on 127.0.0.1 only).

## Install

1. Log in to Claude Code once in Terminal: run `claude`, log in, quit it. If `claude` is not there: `curl -fsSL https://claude.ai/install.sh | bash`. The app's chats use this login (the Agent SDK reads it from the Keychain; untested).
2. Get the code into a normal folder. Not a synced folder (Nextcloud, iCloud Drive, Dropbox): setup fills it with this Mac's own files.

   ```
   git clone https://github.com/CreativLLC/phosphor-os.git ~/phosphor-os
   ```

3. See every step first. Nothing is changed:

   ```
   bash ~/phosphor-os/scripts/setup-mac.sh --dry-run
   ```

4. Run it. It asks for the folder Claude works in (`--workspace DIR` skips the question). No step needs sudo.

   ```
   bash ~/phosphor-os/scripts/setup-mac.sh
   ```

   It installs Node 24 (`brew install node@24`, after it asks), the packages, the page, the speech engine for DICTATE (about 0.7 GB), and Electron as `~/Applications/Phosphor-OS.app`. Then it starts the server as a launchd agent (`os.phosphor.server`, on at every login) and, if you say yes, the app in the menu bar at login (`os.phosphor.app`). If Tailscale is logged in, it turns on `tailscale serve` for the phone.

5. Open **Phosphor-OS** from Spotlight. Log in with the password: the server made one at its first start and saved it as `PHOSPHOR_PASSWORD` in `~/phosphor-os/.env`. Do not print it in a chat; open the file yourself. Change it later in SETTINGS > SECURITY.
6. The first DICTATE asks for the microphone. Click Allow.

## Check that it works

| Check | How |
|---|---|
| Server runs | `launchctl print gui/$(id -u)/os.phosphor.server` says `state = running`; `curl -sI http://127.0.0.1:7337/` answers |
| Server log | `~/phosphor-os/data/server.log`; launchd's own: `~/.local/share/PhosphorOS/serve-launchd.log` |
| App log | `~/.local/share/PhosphorOS/shell-data/server.log` (what failed before the server's log opened) |
| Chat | Open a tab, send "hi". "Not logged in": step 1 |
| DICTATE | Press DICTATE in the app, talk, stop. Nothing heard: System Settings > Privacy & Security > Microphone > Phosphor-OS on |
| DICTATE in any app (untested) | The floating mic (click, talk, click again) or Control+Alt+D. The words are pasted with Command+V into the app in front: the first time, allow Phosphor-OS in System Settings > Privacy & Security > Accessibility (and Automation > System Events). Right click the mic: CLEAN UP, HIDE THE MIC; SETTINGS > VOICE shows it again |
| Phone | `tailscale serve status` shows the https address; open it on the phone |

## Keys

The app's keys use **Control**, not Command: Control+Alt+R brings Phosphor-OS to the front from any app, Control+Alt+Space opens its launcher. Command+C, V, X, A and Q work as usual. The red button hides the window; the Dock icon or the menu bar icon brings it back. In the app, Ctrl+Space is DICTATE; macOS may use Ctrl+Space to switch the input language (System Settings > Keyboard > Keyboard Shortcuts > Input Sources), so turn that off if the two collide.

## Update

```
git -C ~/phosphor-os pull
bash ~/phosphor-os/scripts/setup-mac.sh
launchctl kickstart -k gui/$(id -u)/os.phosphor.server
```

The last line restarts the server. It cuts off every running chat, so do it when no chat is working.

## Uninstall

`bash ~/phosphor-os/scripts/setup-mac.sh --undo` (add `--dry-run` to see it first). It asks before it removes the launchd agents, the app and Tailscale serve. It keeps the project folder, `.env`, `data/`, Node and the speech engine (`~/.local/share/PhosphorOS/voice`).

## Known gaps on a Mac

- SYS panel: no GPU, temperatures or volume. The disk and RAM numbers are rough.
- The launcher lists no installed Mac apps, and the Web and Discord buttons do not show.
- Desktop notifications from the server (calendar, SDK updates) do not show (`notify-send` is Linux only); the app's own notifications do.
- The automatic SDK update installs, but cannot restart the server by itself. Restart it with the `launchctl kickstart` line above.

## Local models on a Mac (not built)

A Mac shares one memory between the CPU and the GPU, so the model must fit next to macOS and the apps. Rough sizes: Qwen3.6 35B MoE at Q4 needs about 22 GB; Qwen-Image 2.1 at Q8 with its text encoder needs about 18 GB; Gemma 4 E4B needs about 6 GB. Both engines run on a Mac with Metal: `brew install llama.cpp` (llama-server) and stable-diffusion.cpp built with `-DSD_METAL=ON`. The app talks to them through `.env` (`PHOSPHOR_LOCAL_*`, `PHOSPHOR_IMAGE_*`; see `.env.example`), but the server starts and stops the engines with systemd units (`server/localrelay.ts`, `server/imagegen.ts`), so a Mac needs launchd versions of those first.
