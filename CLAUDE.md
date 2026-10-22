# Phosphor-OS: how to work on this project

Phosphor-OS is a retro CRT agent desktop: a web UI over Claude Code (Agent SDK), a desktop app (Electron), and an
add-on pack that makes it the desktop of Omarchy (Arch + Hyprland). A new Claude chat should need nothing but these
files to carry on.

## Read first, in this order

1. `private/HANDOFF.md`, then `private/NOTES.md`, if `private/` exists: the owner's live notes (state, what is in
   flight, traps, PC details). `private/` is gitignored and exists only on the owner's PC. Keep HANDOFF current
   while you work. Never commit `private/` to this repo, and never copy personal details from it into tracked
   files. If `private/` is its own git repo (the owner's backup), commit and push it there after updating it.
2. `docs/OMARCHY.md`: every change the pack makes to Omarchy (what, why, file, undo).
3. `PLAN.md`: build record of the app (parts, code map). `docs/LINUX.md`: install. `docs/MIGRATE.md`: moving an
   install from the old name (Retro Claude).

## Where things live

| What | Where |
|---|---|
| Source of truth | this git repo (`git push` to GitHub after each finished change) |
| Linux install | this repo's folder itself; `data/`, `.env`, `private/`, `node_modules`, `web/dist` are gitignored |
| Add-on pack (OS changes) | `os/`: `hyprland/phosphor-os.lua`, `omarchy/` (desktop.sh, themes, bar, screensaver, fonts), `firefox/` |
| Installers | `scripts/setup-linux.sh` (Linux), `scripts/setup-shell.ps1` (Windows), `scripts/setup-mac.sh` (Mac, app only, untested: `docs/MAC.md`); all with dry-run and undo |
| Tests | `tests/pack.sh` (fake HOME, stubs; never touches the live system), `npm run test:docs`, `npm run test:router`, `npx tsc --noEmit -p .`, `npm run build` |
| Server | `systemctl --user restart phosphor-os-server` (port 7337, 127.0.0.1); log `data/server.log` |

## Rules for changing the OS

- **Every OS change goes into the pack, never only into `~/.config` by hand.** Change the file in `os/` (or the
  installer that applies it), apply it with the installer, check it, record it in `docs/OMARCHY.md`.
- Never edit `/usr/share/omarchy/` (the package owns it). Leave Omarchy's own user files as Omarchy made them: our
  Hyprland changes live in `os/hyprland/phosphor-os.lua`, loaded by ONE line at the end of `~/.config/hypr/hyprland.lua`.
- Load the `omarchy` skill before touching Hyprland, the bar, themes or idle settings.
- Check every change: `hyprctl configerrors` after `hyprctl reload`. Bar modules and shell plugins do not hot-reload:
  `omarchy restart shell`. To see the screen: `grim` (export `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` from
  `/run/user/$UID/` first; the app's shell lacks them), then read the PNG.
- QML traps: no function named like an Item property (`focus`); property names start lower-case; bar add-ons get a
  limited `bar` object (no `shellQuote`, no notification service); a bash pipeline in a `Process` outlives the bar.
- Keep the repo generic: no user names, emails, IPs, host or tailnet names, personal paths, hardware details or
  passwords in any tracked file (code or docs). Personal values go in `.env`, `data/` or `private/`. The repo is
  meant to go public: someone else must be able to run it on their own Omarchy.
- Small and clean: no bloat, no unused options, comments only where the why is not obvious.

## Safety (learned the hard way)

- Never expose the app to the internet: localhost + `tailscale serve` only, never `funnel` or `0.0.0.0`.
- Never print the app password (`.env`).
- The chat you are in runs inside the server: a server restart (or the PC running out of memory, which kills the
  whole unit) stops it and every subagent. Restart only when idle; run heavy work (npm ci, builds, test servers) in
  `systemd-run --user --scope -p MemoryMax=6G -- <cmd>`.
- Stop only processes you started (by PID), never by name.
- Tests use `/?demo=1` and never send a chat message; no visible test windows on the owner's screens.
- Admin: anything that needs a password needs the owner at the PC: say so, never leave a password pop-up waiting.
  (An owner may allow a few tools to run with `sudo -n`; if `private/NOTES.md` exists it says which. Assume none otherwise.)
