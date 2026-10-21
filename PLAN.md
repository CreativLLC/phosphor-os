# Phosphor-OS: plan

Renamed from Retro Claude to Phosphor-OS on 2026-10-12. History below keeps the old name; current paths and
commands use the new one. The move for existing installs: `docs/MIGRATE.md`.

This file is the build record: what exists and how it works. Install and use: `README.md`, `docs/LINUX.md`.

## How to run

- First time: `npm install`
- Start: `npm start` (builds the page, then serves http://localhost:7337 through `scripts/serve.mjs`, which
  keeps the server running; see "Working on this app from inside the app")
- Desktop app: run `scripts/setup-shell.ps1` once. It puts
  Electron 44.4.5 (official zip, pinned SHA-256) in `%LOCALAPPDATA%\PhosphorOS\shell` and makes the desktop
  shortcut "Phosphor-OS" (the old Edge one is kept as "Phosphor-OS (Edge)"). `shell/main.mjs`: window + tray.
  It starts the server (hidden, detached) only when nothing listens on the port, and quitting it never stops the
  server. Its own login and profile live in `%LOCALAPPDATA%\PhosphorOS\shell-data` (server log there too).
  Close = hide to tray; tray menu: reload the page, fullscreen, start with Windows (in the tray), open in
  browser, quit. F5 / Ctrl+R reload the page, F11 fullscreen. The window sets its own taskbar app id and icon
  (`setAppDetails`; without it the taskbar showed Electron's atom).
  Window only shows the app's address; other links open in the normal browser; only mic, fullscreen,
  clipboard write and notifications are allowed.
  Real apps (owner's pick 2026-10-11, replaces the built-in WEB/Discord/YouTube buttons): the bar is
  CHAT / Web (real Firefox) / Discord (real Discord app) / saved sites. A button runs focus-app.exe
  (`shell/focus-app.cs`, built by setup-shell.ps1 with Windows' own csc) to bring the program to the front,
  or starts it (`shell/apps.mjs`; paths live in shell-data/prefs.json `apps`, the page only sends an id and can
  rename/remove, never add). Ctrl+Alt+R brings Phosphor-OS back. Tray: "Bring back the Web and Discord buttons".
  Windows only lets the program the user just clicked switch windows: focus-app is started by the app at click
  time; from a background process it is refused (exit 3). Site links that open a new tab go to the normal browser.
  Websites in the app (built 2026-10-11, desktop app only; phone and browsers unchanged): program bar
  CHAT / WEB / saved sites (default Discord, YouTube; right-click a button or + to edit, PIN in WEB).
  Sites are WebContentsViews laid over the slot the page reports (`shell/web.mjs`), own profile
  `persist:web`, http(s) only, popups for sign-in, links to new tabs, camera/mic/notifications/location
  asked once per site (tray: "Forget website permissions"). Page overlays (dialogs, drawers, SETTINGS,
  MENU) hide the site while open. Keys: Ctrl+1..9 programs, Ctrl+T/W/L in WEB, Alt+arrows, F5, Ctrl+/-/0.
  Bridge: `shell/preload.cjs` exposes `window.phosphorShell` on the app's address only; `web/src/shellapi.ts`.
  Gotcha: shells started by VS Code/Claude Code have `ELECTRON_RUN_AS_NODE=1`, which makes electron.exe act as
  plain Node. Unset it to run the app from there. Tests: launch hidden (`--hidden`) with `PHOSPHOR_SHELL_DATA` set to
  a scratch folder, or the test window pops up on your screen.
- The password is in `.env` (made on first start). Change it there; that logs out every device.
- Settings in `.env`: `PHOSPHOR_CWD` (default folder for new tabs; default your home folder), `PHOSPHOR_PORT`.
  See `.env.example`.
- Development: `npm run dev:server` (API on 7337, restarts on change) plus `npm run dev:web`
  (live page on http://localhost:5173). Fake moving data for UI work: http://localhost:5173/?demo=1.
  Sprite review page: http://localhost:5173/sprites.html

## What is built

- **Tabs:** one Claude Code session per tab, each in a chosen folder (workspace or a project).
  Tabs come back after a restart (`data/tabs.json`). Tab names switch to Claude's chat title.
- **History:** lists Claude Code's saved chats (from this app and the terminal); tap to reopen.
- **Mission + progress bar:** the server gives Claude an `update_mission` tool (title, summary,
  steps). Percent = steps done / steps. TodoWrite lists map to the same panel.
- **Agents sidebar:** pixel-art operator for the main Claude plus one animated crew card per
  subagent (Explore, Plan, general-purpose, guide, others). Finished cards stay 2 minutes, then fold
  into one "▸ N DONE" line (tap to show them; nothing is deleted).
- **File explorer:** read-only, rooted at the tab folder, "changed by Claude" list, viewer, @ insert.
- **Look:** amber/green phosphor, CRT effects (off/low/high), text size, sounds, boot screen.
- **Permissions:** approve/deny cards, question cards, permission mode picker per tab.
- **Model and thinking level** pickers per tab (list comes from the SDK); THINKING shows in the mission panel.
- **Attachments:** paste a screenshot, drop files on the chat, or ATTACH. Files land in `data/uploads/<id>/`;
  images go to Claude inline (scaled down in the browser if big), and every path is listed in the message.
- **Wide screens:** side panels grow and sprites get bigger; chat capped at a reading width.
- **Undo:** "UNDO FROM HERE" on each of your messages puts back every file Claude changed after it
  (SDK file checkpoints, preview first). Only works for messages sent after 2026-10-11.
- **Chat look:** Claude's replies bright and larger; runs of tool steps fold into one dim line.
- **Fullscreen:** FULL button (Fullscreen API) and a web app manifest + icons, so the page installs as an app.
- **Scrolling:** the chat stays pinned to the newest line; scrolling up unpins it and shows "▼ LATEST".
- **Working signal:** while Claude works, the progress row turns accent color, breathes, shows a
  running light, an inverse WORKING/THINKING/STEP label and a turn timer.
- **Login:** sessions last 400 days and renew on every app open. SETTINGS > SECURITY has ADD FINGERPRINT
  LOGIN (passkey, per address: localhost and the ts.net name each need their own) and CHANGE PASSWORD
  (writes `.env`, logs out other devices). Passkeys live in `data/passkeys.json`. The server removes
  PHOSPHOR_PASSWORD from its environment so Claude processes do not inherit it.
- **Phones:** "narrow" = width <= 820px OR a touch screen <= 1150px (an unfolded foldable phone): chat full width,
  side panels slide over, one-row header with MENU (AGENTS / HISTORY / INFO / SETTINGS), message box
  with one button row (ATTACH / OPTIONS / DICTATE / STOP / SEND; pickers under OPTIONS).
- **Dictate (voice to text):** DICTATE button or Ctrl+Space; live text as you talk; runs on this PC. See "Voice (DICTATE)" below.
- **Home-screen app:** manifest `display: standalone` + `web/public/sw.js` (no caching; shows a
  "NO SIGNAL" page when the PC can't be reached). Firefox needs the service worker to install it as an app.
- **Context:** "CTX" gauge at the right end of the progress bar (also on phones when idle) and a
  COMPRESS button in the right panel; both send Claude Code's `/compact` after a confirm box.
- **Busy state:** a tab is busy until every message sent has its answer (result `user_message_uuids`),
  or Claude Code's `session_state_changed` says idle. Agent cards are saved in tabs.json.
- **SYS panel** (2026-10-11): third view in the right panel (MISSION / FILES / SYS). Clock, date, uptime, host;
  CPU (and each thread), RAM, GPU, VRAM bars with a 2-minute sparkline; network down/up; drives; PC volume
  (segmented slider + MUTE). `GET /api/system`, `POST /api/system/volume`. Polls every 2 s only while the view is on
  screen and the page visible; the server reads the PC only while asked (stops 30 s after the last ask).
  Windows: `sysmon.exe` (PDH counters + DXGI card list; not typeperf, which misses programs started later) and
  `volume.exe` (Core Audio), built by `scripts/setup-shell.ps1`; run it once after updating. Temperatures: `--` on
  Windows (need admin). Linux (Omarchy): /proc, /sys (amdgpu, hwmon temps), wpctl; fixture-tested only.
  `sysSummary()` in system.ts gives "CPU 12% RAM 41% GPU 3%" for a top bar or launcher (not placed yet).
- **Fun pack** (built 2026-10-12; SETTINGS rows in their own section, saved per device in `phosphor.fun`):
  SCREENSAVER (moved out of the app 2026-10-14: it is the whole computer's screensaver now, a standalone page
  `saver.ts` built to `web/dist/saver/` and shown by the pack, docs/OMARCHY.md row 9; there is no in-app trigger or
  setting): grid flight, stars, crew, big clock, status line; one canvas, 30 fps cap, 1 fps with reduced motion. VOICE OUT (OFF / SHORT / FULL, voice pick,
  chime): reads the active tab's finished reply with the browser's speech, only on the visible and focused
  device; code and tables "omitted", paths read as file names; any key, STOP VOICE, SEND, DICTATE or a new
  message stops it. Real BOOT CHECKS (`GET /api/bootcheck`, cached 30 s): link, login, voice engine, Tailscale,
  workspace disk, Nextcloud client, MCP (only from a running Claude process); the boot never waits for them;
  problems show as one toast after the boot. GAME MODE: CRT, sounds, voice off, all animation
  stops (`html[data-game="on"]`), usage meter every 30 min; OFF puts back what it changed.
- **Accent color** (owner wants only small splashes): `--accent` (cyan, pink or off in SETTINGS), used in
  exactly three places: the operator's face, the progress bar, the NOW line. Keep it that way.
  (One exception: the blinking REC dot on DICTATE, only while recording.)
- **Launcher** (2026-10-11): Ctrl+K, LAUNCH (MENU > LAUNCH on phones; no LAUNCH button in the Linux desktop app, where
  the Super key opens it: `shellApi.platform`, never the user agent) or the desktop app's `launcher` command opens a
  full-screen prompt. Fuzzy search, best first, over PROGRAMS (the program bar), INSTALLED (Start Menu shortcuts;
  `.desktop` files on Linux) and GAMES (Steam library) in the desktop app only, CHATS (open tabs, saved chats),
  FILES (by name in the chat's folder, `GET /api/files/find`, opens the viewer) and COMMANDS (app actions, settings,
  slash commands, which only fill the box). Prefixes: `run`, `chat`, `open`, `>`, `/`. ASK CLAUDE puts the text in the
  message box; nothing is ever sent from the launcher. Recent picks rank higher (`phosphor.launcher.recent`).
  The page sends only ids; `shell/installed.mjs` looks them up in its own scan and launches (`shell.openPath`,
  `gio launch`, `steam://rungameid/`). Other parts add commands with `addLauncherCommands()`.
- **AUTO-CONTINUE** (2026-10-12, owner's ask after a night of agent work sat idle for 5.5 hours after the limit
  reset): when the plan's usage limit stops a chat's work (its own turn gets a `rate_limit` error, or the limit
  refuses while it is busy or has running helper agents, or an agent stops on the limit), the tab saves
  `meta.resume = { at: reset + 90 s, limit }` (reset time from the SDK's `rate_limit_event`; unknown: 30 min, then
  again). Every 30 s `Tabs` checks; when due and the chat is not working, it sends one message
  (`AUTO_CONTINUE_TEXT`, shown as "> AUTO-CONTINUE"). A banner above the progress row shows the time with
  CONTINUE NOW and CANCEL (`web/src/resume.ts`); any message you send cancels it. Saved in tabs.json, so it survives
  a restart or crash (fires right away if the time passed). Off: `PHOSPHOR_AUTO_CONTINUE=off` in `.env`.
  Tested with synthetic SDK messages only (8 cases, not in the repo). Untested against a real limit.
- **OS theme pack** (`os/`, built 2026-10-11, see `os/README.md`): Omarchy 4.0.4 themes `retro-amber`, `retro-green`,
  `lcars` (colors, Quickshell shell.toml, hyprland.lua, btop, previews, boot logo), original wallpapers at 3440x1440,
  2560x1440 and 3840x2160, Firefox userChrome looks with backup/undo installers (Windows + Linux), Windows Terminal
  schemes, optional VT323 font hook. Looks only; the "Retro Claude is the desktop" Hyprland parts belong elsewhere.
- **Linux desktop (built 2026-10-12, untested on Linux):** `scripts/setup-linux.sh` sets up Omarchy 4.0.4
  (Node 24, packages, voice, Electron, a systemd user service, Tailscale serve, desktop mode; `--dry-run`, `--undo`).
  Omarchy 4 reads Hyprland's config as Lua: one `dofile` line in `~/.config/hypr/hyprland.lua` loads
  `os/hyprland/phosphor-os.lua` (start full screen on workspace 1, Super tap = launcher, Super+Alt+R restart,
  Super+Alt+T terminal); the top bar is hidden with Omarchy's own `omarchy-toggle-bar on`. Desktop app: `--desktop`
  (close does nothing), `--launcher` (also as a second start; Windows: Ctrl+Alt+Space; `PHOSPHOR_NO_GLOBAL_KEYS=1`
  for tests), `--docs [file]` (the same, but on DOCS: the "Phosphor Docs" app menu entry; with a file, that file opens in DOCS). The app folder must be outside Nextcloud on Linux. Owner steps: `docs/LINUX.md`.
- **Themes** (built 2026-10-12): SETTINGS > THEME: AMBER / GREEN / LCARS (`html[data-theme]`; an old saved
  `phosphor` still loads). LCARS: flat black panel, orange elbows joining the top bar to the side columns,
  pill buttons, Antonio font (vendored, OFL), LCARS boot screen, sine chirps instead of blips, its own
  multi-color rules (the accent rule above is for amber/green only). CRT and ACCENT rows say "not used" under
  LCARS and keep their value. New theme = one CSS file in `web/src/themes/` + one entry in `web/src/themes.ts`.
- **Claude Code updates** (2026-10-14): new Claude Code features and models arrive only with the
  `@anthropic-ai/claude-agent-sdk` package. The server asks the npm registry hourly (plain `fetch` of `/latest`, failures
  silent); a version inside package.json's range counts as an update (`shared/sdkversion.ts`), a newer minor/major only
  gets a notice ("needs a code check", never installed). Once per version: a desktop notification with an "Update now"
  button (`notify-send --action --wait`, so the bell on Omarchy) and an UPDATE chip in the top bar. Click: confirm box,
  then `POST /api/update` runs `scripts/update-sdk.sh <version>` (also fine by hand): backup of package.json and
  package-lock.json, `npm install` keeping the caret, `tsc` and `npm run test:router`, all in a 4 GB memory-capped
  scope; on failure the files come back and `npm ci` runs; on success `systemd-run --on-active=5` restarts the
  server from outside (`--no-restart` skips it, for tests in a copy). Refused while a tab is busy or waiting for
  you (the box offers UPDATE ANYWAY). At 04:00 local an update that is waiting runs by itself if nothing is busy
  (else the next night; a version whose update failed is not retried at night). After the restart a "Claude Code
  updated to X" notice. Log `data/update.log`, memory `data/sdk-update.json`. `npm run test:sdkversion`.
  Script tested in a copy (success, bad version, type error); the live click, the bell button and the restart
  are untested.
- **Alerts:** the phone buzzes when Claude finishes a turn (DONE) or waits for you (NEEDS YOU), even with the app
  closed (Web Push). Open pages in the background show the alert too (the desktop app this way). SETTINGS > ALERTS.
  See "Alerts (push)" below.
- **DOCS** (2026-10-12): document program. DOCS button (MENU on phones), DOCS next to CHAT in the desktop app's
  program bar, launcher (DOCS, NEW DOCUMENT, recent documents). Takes the chat's place (full screen on phones).
  Files in the docs folder: `PHOSPHOR_DOCS_DIR` in .env, default `~/Documents` (made at the first save).
  `PHOSPHOR_DOCS_READONLY` (default none): shown, never changed. Plain text only (.md, .txt, others if they sniff as UTF-8 text), up to 2 MB.
  DOC / SOURCE: Markdown files open in DOC view, a WYSIWYG editor (TipTap 3 + @tiptap/markdown, own chunk loaded on
  first use; toolbar B I U S H1-3 lists, TODO checklist with real tick boxes, quote, code, link, undo) that saves plain
  Markdown. mdkeep.ts cuts the file into top-level blocks: untouched blocks are written back byte for byte, changed
  ones fresh (escapes dropped where the HTML stays the same, so `[[wiki links]]` and snake_case stay plain). Blocks
  it cannot carry exactly (raw HTML, front matter) show as grey KEPT AS WRITTEN boxes; files it cannot cut (reference
  links) or over 300K chars open in SOURCE with a note. One newline = a line break (Shift+Enter writes one).
  SOURCE = the plain textarea (also .txt); FIND switches to it. Test: `npm run test:docs` (tests/docs-roundtrip.ts
  over tests/fixtures/docs). Storage and reminders plan: `docs/DOCS-PLAN.md`.
  Underline (U, Ctrl+U): Markdown has none, so it is saved as inline HTML `<u>text</u>` (Obsidian, GitHub and agents
  read it); `<u>` in a file opens as underline, not a KEPT AS WRITTEN box.
  Autosave after a pause (SAVED / UNSAVED / SAVING / CONFLICT),
  conflict check by content hash: a file changed on disk (Nextcloud) shows both versions: KEEP MINE / KEEP DISK
  VERSION / KEEP BOTH. Find and replace, word and line count, templates (note, letter, list, blank), print or PDF
  (black on white), ASK CLAUDE (puts `@path` in the message box, never sends). DELETE moves to `<root>/.retro-trash/`
  (TRASH view puts things back). Keys: Ctrl+S, Ctrl+F, Ctrl+P, Esc. API: `/api/docs/*` (shared/docs.ts).
  Title follows the name (2026-10-16): about 2 s after a save settles, a Markdown file whose name matched its old
  first-line `# Title` (or still has a NEW name like "Note 2026-10-16" / "Untitled") is renamed to the new title
  (cleaned for Windows, max 100 letters, same folder); a taken name is never overwritten (kept, with a note).
  Drag and drop in the list (mouse only): a row onto a folder row moves it there, onto the empty list or the folder
  name moves it to the top; a closed folder opens after 0.7 s of hovering. Refused: a folder into itself, read-only
  items or folders, a name already there (any case). Rules: `web/src/docsmove.ts`, test `npx tsx tests/docs-move.ts`.
  OPEN FILES (2026-10-21): a `.md` double-clicked anywhere on the PC opens in DOCS where it is (`phosphor-os.sh --docs
  <file>`, the "Phosphor Docs" entry is the default app for Markdown, docs/OMARCHY.md row 12b). The desktop app's main
  process adds it with `POST /api/docs/open-local` (no cookie: loopback, no proxy headers, the key in
  `data/docs-open.key`, mode 600), then sends the page `docs-open:<path>`; a second start hands the file to the running
  window (single-instance `additionalData`). The page names such files `ext:<id>/<file name>` and can only open them or
  take them off the list (`GET opened`, `POST unopen`), never add one. Each read and save resolves the real path again:
  same path, a regular .md/.markdown/.mdown/.txt file, PHOSPHOR_DOCS_READONLY respected. No rename, move, delete or
  KEEP BOTH for them. List: `data/docs-open.json`. Test: `npx tsx tests/docs-open.ts` (in `npm run test:docs`).
- **STATION** (2026-10-12): homelab hub. STATION button (MENU on phones), launcher `STATION` / `OPEN <name>`. A wide
  drawer of your services (`data/station.json`: name, address, kind, SELF-SIGNED, SKIN; edited in the app):
  UP / SLOW (2 s+) / DOWN lamp, response time, last seen, sparkline of the last 40 checks; OPEN (desktop app: a
  saved site with that address or a WEB tab; self-signed ones go to the normal browser; elsewhere a new tab), EDIT,
  REMOVE. Checks: server GET, 3 s limit, stops at the headers, same-host redirects only, once a minute and only while
  some screen has STATION open (`GET /api/station` while open; `?peek=1` does not count). DISCOVER: one host on the
  owner's own network only (loopback, RFC 1918, link-local, 100.64/10, *.ts.net, IPv6 ULA; a name must resolve only
  there and the probe connects to the checked address), about 40 common ports, 6 at a time, page title -> app guess;
  one at a time, 8 per 5 minutes. SKIN (desktop app): `shell/skins.mjs` inserts `shell/skins/<app>.css` into those
  sites' panes on every page (Nextcloud + AIO, *arr, Unraid login, Plex light, Immich untested, others frame only),
  in the app's theme (amber, green, lcars), and swaps it when the theme changes.

## Phone setup (Tailscale)

1. PC: install Tailscale and log in (Windows: `winget install Tailscale.Tailscale`; Linux: `docs/LINUX.md`).
2. Phone: install Tailscale, log in with the same account; set it as Always-on VPN.
3. login.tailscale.com/admin/dns: MagicDNS on, HTTPS Certificates on.
4. PC: `tailscale serve --bg 7337` (prints https://<pc>.<tailnet>.ts.net). Never `tailscale funnel`.
5. Phone: open that address, log in, browser menu > Add to home screen > Install (opens full screen).

## Voice (DICTATE), built 2026-10-11, live since 2026-10-11

- **Use:** press DICTATE or **Ctrl+Space** (anywhere in the app), talk, press again. "● REC 0:05" and a
  level bar show while recording. **Live:** a dim line above the message box shows the phrase you are
  saying (updates about once a second); when you pause, the whole phrase is decoded once more and goes in
  at the cursor in the message box. Stopping turns the last phrase into text (TRANSCRIBING…, phone:
  WAIT…). Nothing is sent. **Esc** cancels and drops the phrase not yet in the box. Up to 10 minutes per
  take. Works on the phone over the ts.net HTTPS address (the mic needs https or localhost).
- **Engine:** NVIDIA Parakeet TDT 0.6B v2 (int8, English, adds punctuation and capitals) on
  sherpa-onnx 1.13.8, on the CPU, plus Silero VAD to find the pauses. Chosen over Whisper because the first PC
  had an AMD GPU (no CUDA) and whisper.cpp ships no Vulkan build for Windows: Whisper large-v3-turbo on
  the CPU took 6.3 s for an 11 s clip; Parakeet takes 0.45 s, with the same or better accuracy.
  No prompt hints: this model has no prompt, and its hotword mode needs files the model doesn't ship.
- **Installed in** `%LOCALAPPDATA%\PhosphorOS\voice` (0.65 GB, outside any synced folder): `node_modules/`
  (sherpa-onnx-node + sherpa-onnx-win-x64 from npm), `models/parakeet-tdt-0.6b-v2-int8/`,
  `models/silero_vad.onnx`, `install.json`. Install or repair: `powershell -ExecutionPolicy Bypass -File
  scripts\setup-voice.ps1` (skips parts already there; `-Force` reinstalls all, close the app first).
  Every download is checked against a hash pinned in the script (npm sha512 integrity; GitHub release
  sha256: model `157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad`, VAD
  `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`). Other folder: `PHOSPHOR_VOICE_DIR` in `.env`.
- **How it runs:** the page's AudioWorklet resamples the mic to 16 kHz (own 97-tap low-pass) and streams
  100 ms blocks of 16-bit PCM (32 KB/s) over the WebSocket `/ws/voice` (same login and Origin checks as
  `/ws`). `server/voice.ts` forks `server/voice-worker.mjs` (plain Node) on first use and talks to it over
  the IPC pipe: no network port. In the worker, Silero VAD ends a phrase after 0.8 s of silence (or at
  20 s); while a phrase is open it is re-decoded for the preview about every 0.8 to 1 s (never more than
  half the time); at the pause the whole phrase is decoded once (the FINAL). One decode at a time; finals
  first. 2 decoder threads: 4 were 30% faster but cost 2.5x the CPU (ONNX Runtime threads spin after
  each decode). The worker exits with the server and after 20 minutes idle (gives back about 1 GB).
- **Fallback:** if the live socket can't connect (server not updated, VAD missing) or breaks, the take
  goes on, and on stop the audio not yet turned into text goes in one piece to POST /api/transcribe.
- **API (login needed):** WebSocket `/ws/voice` (`VoiceLiveEvent` in shared/protocol.ts: ready, partial,
  final, done, error; the page sends binary PCM, then `{"t":"end"}`; closing cancels), GET /api/voice,
  POST /api/voice/warm, POST /api/transcribe (16 kHz mono 16-bit WAV, `Content-Type: audio/wav`, up to
  5 minutes) -> `{ text, ms, seconds }`. 503 when the engine is not installed.
- **Tuning (optional, `.env`):** `PHOSPHOR_VOICE_THREADS` (default 2), `PHOSPHOR_VOICE_PAUSE` (seconds of
  silence that end a phrase, default 0.8), `PHOSPHOR_VOICE_PARTIAL_MS` (preview cadence, default 800).
- **Measured (2026-10-11, TTS clips):** live finals vs one-shot on the same audio: 1.2% vs 1.2% word
  errors over a 5-minute take, 1 vs 5 word errors on a 36 s take; punctuation and capitals as good or
  better. A preview about every 0.95 s. Worker CPU while talking 1.7 cores (9% of a 20-thread desktop CPU), two
  people at once 2.6 cores; page main thread about 2% of one core, no long tasks. Stop to last text:
  0.2 s if you paused first, 0.4 to 0.8 s mid-phrase; fallback 1 s for a 12 s take.
- **Page:** `web/src/voice.ts`, `web/src/voice.css` (button, live line, phone grid).
- **Fast start on phones (2026-10-11):** Firefox on Android creates the AudioContext suspended and only
  resumes it inside a tap, so `resume()` and the worklet load now start in the tap, while the mic starts
  (the old code waited until after getUserMedia: "MIC…" hung). While the PC's engine is still loading,
  the preview line says so. Each take's timings go to `data/voice-diag.log` (`POST /api/voice/diag`, one
  JSON line per take; rotates at 256 KB) to find slow starts.

## Alerts (push), built 2026-10-12

- **Use:** SETTINGS > ALERTS ON THIS DEVICE: ON (the browser asks once), TEST, ALERT WHEN (DONE, NEEDS YOU),
  QUIET HOURS (PC clock), DEVICES (rename, REMOVE). Blocked in the browser: the note says how to allow it.
- **When:** a tab goes busy -> idle (DONE, at most one per tab per 20 s, sent 1.5 s later if still idle) or starts
  waiting for a permission or question (NEEDS YOU). No push for a tab someone is looking at: each page reports its tab
  and "visible and focused" over /ws (`presence`: on change, and every 20 s only while looking; stale after 30 s).
- **Push:** `server/push.ts`, node:crypto only: RFC 8291 encryption (the push service can't read it), RFC 8292
  VAPID, RFC 8030 headers (TTL 6 h, Urgency high, Topic per tab). Message: title, tab name (40 chars), tab id. No
  chat text, no paths. Keys `data/push-keys.json` (private key never leaves it), devices `data/push-subs.json`.
  Only https endpoints on Mozilla, Google FCM, Microsoft WNS and Apple push hosts; 404/410 drops the device.
- **Page:** `web/src/alerts.ts`: background alerts through the service worker (Electron: `new Notification`), tag
  `phosphor-<tab>` shared with the push so one event = one alert. `web/public/sw.js`: push, click (focus the app and
  switch tab, or open `/?tab=<id>`), pushsubscriptionchange.
- **API (login needed):** GET /api/push, POST /api/push/subscribe, /unsubscribe, /prefs, /test (shared/protocol.ts).
- **Tests only:** `PHOSPHOR_PUSH_TEST_ORIGIN=http://127.0.0.1:<port>` allows that one loopback mock push service and
  turns on POST /api/push/simulate. Never put it in `.env`. Optional `PHOSPHOR_PUSH_CONTACT` (VAPID contact, a mailto:).

## Ideas

- SYS as a small panel in the lower left (a few key readings, always visible) that expands to the full SYS view.
- DOCS connected to other services (Google Tasks, Google Drive, Nextcloud over WebDAV).
- STATION health beyond UP: CPU, disks, containers, SMART, backups.
- Crew XP: agents earn XP and level up (decoration only; Claude never sees it).
- Phone keyboard dictation everywhere on Android: an OpenAI-style `POST /v1/audio/transcriptions` with a token, for
  keyboards like Dictate Keyboard (github.com/DevEmperor/DictateKeyboard) that take a custom server.

## MCP servers, connectors and the "/" menu

- The app already loads the same MCP servers as the CLI: tabs do not set `settingSources`, so the SDK loads
  user, project and local settings, plugins and claude.ai connectors.
- claude.ai connectors log in on claude.ai (Settings > Connectors). Local servers log in with `/mcp` in a terminal `claude`.
- Built 2026-10-11 (see and fix; adding servers stays in the terminal: a server is a program on the PC):
  - MCP screen: MCP button (in MENU on phones) or type `/mcp`. Status lamp per server (ON, WAIT, LOGIN, FAIL, OFF),
    tool list, RECONNECT, TURN ON / TURN OFF, login help. `server/mcp.ts` + `Tab.mcpServers()` / `Tab.mcpAction()`.
  - Only safe fields go to the page (name, status, source, kind, version, error, tool names). Never the config: it can hold keys.
  - TURN OFF is saved by Claude Code in `~/.claude.json` > `projects[<folder>].disabledMcpServers`, same as `/mcp disable`
    in the terminal. So it is per folder, not per tab. Turning on a server that needs a login throws "needs-auth"; not an error.
  - Status works before the first message: asking starts the tab's Claude process (nothing is sent). Servers show WAIT ~2 s.
- "/" menu (built 2026-10-11): type `/` at the start of the message box. List comes from `supportedCommands()`
  (`GET /api/commands`), minus terminal-only ones (`terminal_slash_commands` from init). Enter runs a command with no
  arguments, Tab or a tap fills it in. Skills/plugins show in the accent color. `/mcp` alone opens the app's MCP screen.
- Local commands (`/context`, `/usage`, `/mcp ...`) already worked as text: Claude Code answers them as a plain reply.
  The terminal's full-screen menus can't show in the SDK; that is why the app has its own screens.

## Speed rules (learned 2026-10-10)

- Never loop a CSS animation on background, color, box-shadow or width. It repaints the whole
  page every frame. Use `steps()` blinks, or animate only `transform` / `opacity` on a small layer.
- CRT HIGH flicker and rolling band are short runs started by `web/src/crt.ts` at random moments.
  Do not turn them back into infinite animations (full-screen GPU redraw every frame).
- Streaming replies re-render markdown about 12 times a second (`STREAM_MS` in chat.ts), not every frame.
- Chat items use `content-visibility: auto`, so off-screen messages cost nothing.
- Measure with a headless Edge trace (Paint / UpdateLayoutTree totals) before and after a change.

## Working on this app from inside the app

Tabs reopened from HISTORY run in the workspace folder (`PHOSPHOR_CWD`), so Claude keeps the workspace's
CLAUDE.md and memory. HISTORY opens old chats there
(`Tabs.open`), not in the folder the chat last ran a command in. Claude's init message reports the Bash
tool's current folder (it moves on a top-level `cd`), so `Tab.onSystem` keeps the tab's own folder.
In Bash, use absolute paths or `( cd ... && ... )`.

When you run Claude in Phosphor-OS itself, so a server restart mid-reply cuts that reply off (Claude Code
then writes a "<synthetic>" "No response requested." line into the chat log; 7 of those on 2026-10-11).
Since 2026-10-11 the live server runs under `scripts/serve.mjs`, not `tsx watch` (which restarted on file events
and on any input to its window, with no code change). serve.mjs: plain `node --import tsx server/index.ts`, no
watcher; restarts it on a crash (logged); restarts on purpose only when `data/restart-request` appears (the
reason goes in the file and the log); one supervisor at a time (`data/serve.lock`); log `data/server.log`.
The lock is `{ pid, boot }`: a lock from an earlier boot, an old-style lock, or a pid that is not node.exe (Linux:
not this script) is stale. Before 2026-10-12 a reused pid after a reboot made the supervisor exit silently and the
app showed NO SIGNAL. The desktop app now tries two start rounds, then NO SIGNAL keeps checking every 5 s and opens
the app by itself (tray: "Start the server").
Saving a server file no longer restarts anything: it loads at the next restart.
How to change server code safely:
1. Copy the files to change into `.staged/` (same paths, e.g. `.staged/server/tab.ts`) and edit them there.
2. Typecheck: copy the project to `.patchtest/`, lay `.staged/` over it, run tsc there, delete it.
3. Page code must not import new *values* from `shared/` until the update lands (types are fine).
   Build the page now (`npm run build`).
4. Start `scripts/apply-when-idle.mjs .staged` detached (PowerShell `Start-Process`). It waits until no
   tab is busy for 5 s, copies the files in, writes `data/restart-request` (one restart), deletes `.staged/`,
   logs to `data/apply-when-idle.log`. Then press F5.
A restart also ends the tab's Claude process and every subagent it runs: never restart while agents work.
Subagents inherit the `phosphor` MCP server (was `retro`); a staged fix keeps their `update_mission` calls off the main panel.
Tests: never pick server processes by name or command line (that matched the live server once and closed it).
Use a copy on another port (`PHOSPHOR_PORT`) and only the pids from that copy's own `data/server.log`.

## Code map (who owns what)

| Area | Files |
|---|---|
| Server core | `server/index.ts`, `server/tabs.ts`, `server/tab.ts`, `server/auth.ts`, `server/config.ts` |
| Files API | `server/files.ts` |
| Shared types | `shared/protocol.ts` (WebSocket events and REST shapes) |
| Page core | `web/src/main.ts`, `store.ts`, `net.ts`, `chat.ts`, `tabs.ts`, `history.ts`, `md.ts` (+ `mdlists.ts`: numbered lists after a text line, `tests/mdlists.ts`), `demo.ts`, `layout.css` |
| Look | `theme.css` (token contract at top), `chat.css`, `settings.ts`, `sound.ts`, `boot.ts`, login page |
| HUD | `mission.ts`, `mission.css` |
| Cache clock | `shared/cache.ts` (TTL from usage, time left), `noteCache` in `server/tab.ts` (live replies + reopened chats), `cacheOf`/`watchCache` in `web/src/context.ts` (CTX gauge suffix), CACHE row in `mission.ts`, `tests/cache.ts` |
| Agents | `agents.ts`, `agents.css`, `sprites/` |
| TODAY panel (calendar + reminders) | `server/calendar.ts` (`GET /api/today`, 10-min fetch, cache file), `server/icsexpand.ts` (pure ICS expansion), `web/src/today.ts`, `today.css`, `docs/CALENDAR.md`, `tests/calendar.ts` |
| Month view (opened from the TODAY heading) | `GET /api/calendar` (`calendarRange` in `server/calendar.ts`), `web/src/calendar.ts`, `calendar.css`, `calfmt.ts` (shared text helpers, EDIT / + NEW links), `demoMonth` in `demo.ts`; Google Calendar links (EDIT, + NEW): `server/gcal.ts` (pure, tested) |
| Files UI | `files.ts`, `files.css` |
| Voice | `server/voice.ts`, `server/voice-worker.mjs`, `web/src/voice.ts`, `voice.css`, `scripts/setup-voice.ps1` |
| Desktop app | `shell/main.mjs`, `shell/web.mjs`, `shell/preload.cjs`, `scripts/setup-shell.ps1` |
| Websites (page) | `web/src/programs.ts`, `browser.ts`, `sitebox.ts`, `browser.css`, `shellapi.ts` |
| Plan usage meter | `server/usage.ts` (`GET /api/usage`, experimental SDK usage call, cached), `web/src/usage.ts`, `usage.css` |
| Linux | `scripts/setup-linux.sh`, `setup-voice.sh`, `phosphor-os.sh`, `os/hyprland/phosphor-os.lua`, `server/osdirs.ts`, `shell/apps.mjs` (hyprctl), `docs/LINUX.md` |
| Alerts (push) | `server/push.ts`, `web/src/alerts.ts`, `alerts.css`, `web/public/sw.js` (push, notificationclick) |
| MCP + "/" menu | `server/mcp.ts`, `Tab.mcpServers/mcpAction/commands` in `server/tab.ts`, `web/src/mcp.ts`, `slash.ts`, `mcp.css` |
| Launcher | `web/src/launcher.ts`, `launcher.css`, `shell/installed.mjs` (scan + launch by id), find in `server/files.ts` |
| SYS panel | `server/system.ts`, `server/localmeter.ts` (local model speed), `shell/sysmon.cs`, `shell/volume.cs`, `web/src/system.ts`, `system.css` |
| OS theme pack | `os/` (`os/tools/palettes.mjs` is the color source; `build-themes.mjs`, `wallpapers.mjs` regenerate) |
| Themes | `web/src/themes.ts` (registry, how to add one), `web/src/themes/*.css` (LCARS: `lcars.css`), `boot-lcars.ts`, `fonts/antonio/` |
| DOCS | `server/docs.ts` (OPEN FILES too), `shared/docs.ts`, `web/src/docs.ts`, `docs.css`, `docs-editor.ts` (DOC view), `mdkeep.ts` (Markdown blocks), `docsmove.ts` (rename/drop rules), `openDocsFile` in `shell/main.mjs`, `tests/docs-roundtrip.ts`, `tests/docs-move.ts`, `tests/docs-open.ts` |
| Fun pack | `web/src/fun.ts` (start, launcher commands), `funsettings.ts`, `funsection.ts`, `fun.css`, `saver.ts/.css` (the OS screensaver page, own build `vite.saver.config.ts`), `shipvoice.ts`, `speech.ts`, `gamemode.ts`, `bootchecks.ts`, `server/bootcheck.ts` |
| AUTO model | `shared/router.ts` (parse the pick, stickiness rule), `server/router.ts` (Haiku call), `Tab.send/route` in `server/tab.ts` (applies, tags, logs to `data/auto-router.jsonl`), `web/src/pickers.ts`, `scripts/auto-eval.ts` (router only, on recent chats), `tests/router.ts` |
| HISTORY drawer | `Tabs.history/searchHistory` in `server/tabs.ts` (`GET /api/history[?all=1]`, `GET /api/history/search?q=`), `server/transcripts.ts` (entrypoint filter: this app's chats are `sdk-ts`; chat text, match, snippet, cache), tab name saved to its session in `Tab.saveSessionTitle`, `web/src/history.ts` (ALL CHATS toggle), `tests/history.ts` (`npx tsx tests/history.ts`) |
| SDK update | `server/sdkupdate.ts` (hourly npm check, bell notice, `GET/POST /api/update`, 04:00 run), `shared/sdkversion.ts` (range rules), `scripts/update-sdk.sh`, `web/src/sdkupdate.ts`, `sdkupdate.css` (UPDATE chip), `tests/sdkversion.ts` |
| STATION | `server/station.ts`, `server/lan.ts` (allowlist, probes, DISCOVER), `shared/station.ts`, `web/src/station.ts`, `station.css`, `shell/skins.mjs`, `shell/skins/*.css` |

## Design goals

A custom interface for working with Claude Code, styled like a 1980s vision of a future computer:
the ship computer in Alien (MU-TH-UR), Blade Runner terminals, with a dash of Fallout Pip-Boy
character animation and pixel art. Not the 1950s Fallout look, just the Pip-Boy style sprites.

- **Monochrome phosphor look.** Amber or green, a setting so both can be tried live.
- **CRT feel.** Glow, scanlines, slight screen curve, subtle flicker.
- **One screen for everything:**
  - the chat with Claude
  - a progress bar for the overall task
  - one card per running agent, each with its own animated pixel-art sprite, a one-line
    summary of what it is doing, and stats (tasks done / left)
- **Works on the phone too**, including a foldable used unfolded like a tablet.

## Key decision

**Do not rewrite Claude Code.** Build a skin on top of it.

- Use the **Claude Agent SDK**: Claude Code's engine as a library, with the same tools,
  permissions, sessions, CLAUDE.md and MCP behavior. Check the current package name and
  API in Anthropic's docs before starting (TypeScript and Python versions exist).
- Build it as a **web app served from your own PC**.
  - On the PC: open it in a browser window.
  - On the phone: open the same page, and install it as a PWA (app icon, full screen).
- Rejected: a Windows Terminal theme plus a Claude Code mod. It looks great on the PC, but
  it can't show on the phone.
- Rejected: Claude's own Remote Control screens. They can't be restyled.

## Hard rule: security

The app can run commands and edit files on your PC. It must **never be reachable
from the internet.**

- Access only over **Tailscale** (private network between the phone and the PC) or localhost.
- A **login** on the app as a second layer (signed cookie, slows down wrong guesses).
- The server binds to **127.0.0.1 only**. The phone reaches it through `tailscale serve --bg 7337`,
  which gives a private HTTPS address (`https://<pc>.<tailnet>.ts.net`) that only tailnet devices
  can open. HTTPS is also what Android needs to install the page as an app.
- **Never use `tailscale funnel`.** Funnel puts the app on the public internet.
- Keep Claude Code's permission prompts. Show them in the UI as approve/deny buttons
  (the SDK has a hook for this). Do not auto-approve everything.

## Suggested stack (adjust if there's a good reason)

| Part | Choice |
|---|---|
| Server | Node + TypeScript, Agent SDK, WebSocket to the browser |
| Front end | Vite + TypeScript (React optional), installable PWA |
| CRT effect | CSS first (text-shadow glow, scanline overlay); a WebGL shader pass later if CSS isn't enough |
| Pixel art | PNG sprite sheets on canvas with `image-rendering: pixelated`, tinted to the phosphor color |
| Font | A VT220 or terminal-style pixel font (for example VT323 from Google Fonts) |

## Where the dashboard data comes from

All of it comes from the SDK's message stream. No guessing.

- **Agent cards:** subagent (Task tool) start and finish events. Each one gets a sprite, a
  summary (its task description) and a live status line from its latest tool call.
- **Overall progress:** Claude's todo list (TodoWrite) gives done / in progress / pending,
  so percent = done / total.
- **Stats:** counts of tool calls, files changed, time running, todos done and left.
- **Permission prompts:** the SDK's permission callback, shown as a styled approve/deny dialog.

## Build steps (the order it was built in)

1. **Chat working.** Server runs a Claude session in a chosen project folder. The browser
   shows the chat and streams replies. Plain styling. Check: send a message from the PC and
   from the phone over Tailscale.
2. **The look.** Phosphor colors (amber/green switch), CRT glow and scanlines, pixel font.
   Check: both colors on the PC and the phone.
3. **Progress and stats.** Overall progress bar from the todo list, plus the stats panel.
4. **Agent cards.** One card per subagent with summary, status and progress.
5. **Pixel-art sprites.** One idle animation and one working animation per agent card, plus a
   done pose. Start with 2 or 3 simple sprites; more later.
   (Steps 1 to 5 done 2026-10-10, plus tabs, history and file explorer.)
6. **Phone polish.** Layout for phones, folded and unfolded, PWA install, login.
7. **Nice to have, later:** sounds (soft terminal beeps), boot-up screen ("MU-TH-UR 6000"),
   picking which project folder to work in.
