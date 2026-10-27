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
- **Agents sidebar:** the OPERATOR scene on top (see "OPERATOR scene" below), then one compact row per
  subagent (job, time, type, status; tap for counts, model and its last line). Finished rows stay 2 minutes.
- **File explorer:** read-only, rooted at the tab folder, "changed by Claude" list, viewer, @ insert.
- **Look:** amber/green phosphor, CRT effects (off/low/high), text size, sounds, boot screen.
- **Permissions:** approve/deny cards, question cards, permission mode picker per tab.
- **KEYWORDS:** YouTube keyword check like vidIQ, no API key: demand, competition and a score per search term, top videos, related searches, tags; screen and command line (`docs/KEYWORDS.md`).
- **LAB prompt library and + MODELS** (2026-10-26, owner's ask: rerun the exact same prompt on new models; a library of prompts to test models at any time; `docs/MODEL-LAB.md` section 5): in NEW TEST, LIBRARY lists every prompt used before (HISTORY and ARCHIVE), newest first, one row per distinct prompt text with its title, the start of the text, how many tests used it and the last date, plus a filter; a pick fills the title and prompt (asks before replacing typed text) and the owner picks models, effort and time limit and STARTs a new test. On a test, + MODELS runs the same prompt on more models inside it, with the test's own effort and time limit: the same model picker as NEW TEST without the models already in the test, results appended last (a blind, unrevealed test gives them the next letters), 12 models at most per test, an archived test works too. Server: `GET /api/lab/prompts` (`promptLibrary` in `shared/lab.ts`), `POST /api/lab/tests/<id>/models` `{ models }` -> `{ added }` (400 for a model already in the test or one the lab no longer has; test.json is read and written back with nothing awaited in between, result folders and result.json first). `runner` in `server/lab.ts` holds the model list and the queue so tests can swap fakes. Demo data for all of LAB: `web/src/labdemo.ts`. Tests: `npx tsx tests/lab-library.ts`.
- **LAB FOLLOW UP and versions** (2026-10-26, owner's ask: talk to a model again after it finished, to fix a page that did not follow the prompt; `docs/MODEL-LAB.md` section 5): FOLLOW UP on every finished result opens a small chat (the prompt folded, each reply and follow-up, VIEW per version, DICTATE and SEND; beside the cards on a wide screen, the whole screen on a phone). The same model, app and effort with the test's time limit works on in the same files folder through the normal queue; the app's session is gone with the box HOME, so the prompt carries the task, the earlier follow-ups, the start of its last reply and the follow-up (`followUpPrompt`). Before each follow-up and RUN AGAIN the result is kept in `versions/<n>/` (result.json, reply, log, and files/ as a reflink copy; without reflinks the junk folders are left out; RUN AGAIN moves files/ there); a lab-made page build is removed after the copy so the old page never shows; VIEW opens a version's page in the same locked viewer (`/lab/v/<key>/<test>/<result>@<n>/`). Fair play: a +N FOLLOW-UP badge (cards, table, ranking, OPEN BIG, HISTORY results); a follow-up clears that result's stars and rank and the ranking closes up; blind tests stay blind. RUN AGAIN works on DONE results too and asks first. Server: `server/labfollow.ts`, `POST /api/lab/tests/<id>/results/<dir>/followup` `{ text }` -> `{ version }` (400 while it runs, builds or keeps a version), `GET .../versions`, `POST .../again` keeps a version. Tests: `npx tsx tests/lab-followup.ts`. Later: a true session resume.
- **Model and thinking level** pickers per tab (list comes from the SDK); THINKING shows in the mission panel.
- **Gemini chat:** a tab can talk to Gemini instead of Claude (Google AI Pro sign-in, through `agy`). See "Gemini chat" below.
- **Attachments:** paste a screenshot, drop files on the chat, or ATTACH. Files land in `data/uploads/<id>/`;
  images go to Claude inline (scaled down in the browser if big), and every path is listed in the message.
- **Wide screens:** side panels grow (the scene doubles its pixels once the panel is 420 px wide); chat capped at a reading width.
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
  HEALTH (2026-10-26, `docs/STATION.md`): (1) every tile has a 24-hour uptime strip (96 blocks of 15 minutes, newest on the
  right) and "24H 99.8% UP · AVERAGE 143 MS": `server/stationhealth.ts` counts every check into 15-minute cells
  (`data/station-health.json`, about 2 KB a service, rolled daily). So the strip is not empty while you are away, a round
  also runs every 10 minutes with nobody looking (`startStation()`; open STATION still checks every minute). (2) UNRAID
  panel above the tiles, from Unraid's own read-only GraphQL API (built in since Unraid 7.2, the Unraid Connect plugin
  before): array state, parity check (progress, last result), every disk (temperature, used, errors, SMART, spin), cache
  pools, CPU, RAM, uptime, Docker, VMs, unread notices, UPS, backups (the last parity check; Unraid's API cannot say when
  a flash backup last ran). `.env`: `PHOSPHOR_UNRAID_URL`, `PHOSPHOR_UNRAID_KEY` (a VIEWER-role key),
  optional `PHOSPHOR_UNRAID_SELF_SIGNED=1` and `PHOSPHOR_UNRAID_SMART=1` (SMART status, off by default and at most once an
  hour: Unraid's API fills it with `smartctl -H` on every disk, which can wake spun-down ones; Unraid's own
  notifications still say when SMART complains). `server/unraidapi.ts` holds the questions in one place (nine short documents,
  one per part, so one part failing or a field an older Unraid lacks costs only itself: "Cannot query field" errors are
  cut out of the question and it is asked again), `server/unraid.ts` polls (about 60 s while STATION is open, 10 minutes
  otherwise), keeps the last answer and serves the cleaned summary at `GET /api/station/unraid` (login needed; `?peek=1`
  does not count as "on screen"). (3) Alerts, as rows on the panel and a number on the STATION button (with services
  that are DOWN): array not started, disk disabled or with errors, disk hot (Unraid's own temperature limits), parity
  errors, container stopped (set to auto-start, or seen running and stopped within 24 h; `data/station-unraid.json`
  remembers which ran), VM crashed, UPS on battery, unread Unraid alerts. No push alerts yet. Secrets: the key and the
  address are taken out of `process.env` at start, live in a `Link` whose key cannot be printed, and never reach the page,
  a log, `data/` or any chat (no chat tool, MCP tool or prompt line; `tests/station-unraid.ts` checks the wiring). Demo:
  `/?demo=1` (`&unraid=off`, `&unraid=down`). Tests: `npx tsx tests/station-unraid.ts` (made-up fixtures from the
  schema, a fake `send`, mock servers on loopback; never a real Unraid). Untested against a real server.
- **ROUTER** (2026-10-25, owner's ask: use the local models where they can do the work, keep a cloud orchestrator, spend fewer plan tokens; `docs/ROUTER-PLAN.md`): with a local model set up, cloud chats get `ask_local` (`mcp__phosphor__ask_local`, main chat only, runs without asking): `{ task, files?, max_words? }`. The server reads the files itself (inside the chat's folder, uploads and project folder after following links; no `.env`, keys or `.ssh`; text only; 20 files; cut to the model's window at 1.6 characters a token), so their text never reaches Claude; the local model answers without thinking; Claude gets the answer under a one-line header. Model: the router model that is loaded, loading or sleeping, else the first router model; never Strata; BUSY when the image engine is up or busy (also when another app started it) or a Strata server holds the card, loads or answers; no swap (relay header `x-phosphor-no-swap`: 409 when another model would give the card up); not the app's own `data/` (except uploads, projects); files the chat read itself before a job do not count as kept off; DOWN when the router does not answer. One job at a time (3 may wait, 180 s), through the relay (GPU turn, SYS speed), 180 s to the first piece, 240 s in all (the wait included), STOP cancels. A short text in the system prompt says when handing off pays and that Claude checks the answer. `start_thread` takes `worker` (local, haiku, sonnet, opus; default the lead's model; local = a thread chat on that local model at medium). Ledger `data/router.json`: calls, failures, local tokens in/out, and Claude tokens kept off (file text at 4 characters a token, each file once per chat, less the answers, taken back when Claude reads the file itself); ROUTER card in the mission panel, `GET /api/router`. AUTO does not pick a local model (switching a running chat is not clean; see the plan). `PHOSPHOR_ROUTER=off` turns it off. Tests: `npx tsx tests/delegate.ts`.
- **DECIDE** (2026-10-27, owner's ask: a fast "system one" model for small decisions; `docs/LOCAL-MODEL.md` "Decision model"): `server/decide.ts` is one client for any `POST /v1/systemone` engine (TypeSafe's format: llama.cpp's `llama-server` with a decision model, TypeSafe's Jev in the cloud). `askDecision(state, questions, { timeoutMs, signal })`: typed `noul` / `choice` / `score` questions in, typed answers out (probability, choice, confidence), never throws; no answer = `{ ok: false, reason }` (`off`, `down`, `timeout`, `aborted`, `error`) so the caller falls back. An engine that is not there is left alone for 5 s. `.env`: `PHOSPHOR_DECIDE_URL` (default 127.0.0.1:8090), `_KEY`, `_MODEL`, `PHOSPHOR_DECIDE=off`. `scripts/setup-decide-model.sh` installs Kev-0.8B on the CPU as `phosphor-decide.service` (about 1 s a call, 2 GB awake); `scripts/decide-bench.ts` measures an engine on the hand-made set in `tests/fixtures/decide-cases.ts` (numbers in the doc). Tests: `npx tsx tests/decide.ts`.
- **AUTO model** (AUTO in the model picker; per message, only for chats set to AUTO): the router picks Opus, Sonnet or Haiku, a thinking level and whether the message starts a new topic; `shared/router.ts` applies it (going up always, down only on a new topic; levels held to what the model supports). Since 2026-10-27 the pick comes first from the decision model (`server/decide.ts`): the rubric as three questions (`ROUTE_QUESTIONS`: choice model, choice level, noul new topic) on the same text Haiku reads (the message cut to 1,500 characters), 2 s at most. Its pick counts when it is at least 25% sure of the model (`ROUTE_MIN_CONFIDENCE`); Opus then gets at least high. Off, down, slow, unsure or a bad answer: one Haiku call with the rubric (8 s), as before; both failing keeps the chat's model (Opus, high for a first message). The AUTO tag under the message ends with who decided and the time, "(decision model, 0.9 s)" or "(Haiku, 3.1 s)"; `data/auto-router.jsonl` also logs `engine`, `decision` (picked, unsure (12%), off, down, timeout) and the probabilities. AUTO never picks a local model. Tests: `npm run test:router`; check on real chats: `npx tsx scripts/auto-eval.ts`.

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

## CLEAN UP (messy dictation to a clean request), built 2026-10-25

- **Use:** CLEAN UP sits next to DICTATE (on a phone it says CLEAN). Type or dictate, press it: filler words (um, uh, like,
  you know), stutters, repeated starts and spoken corrections ("at 5, no wait, 6" becomes "at 6") go, punctuation and capitals
  are fixed, and it reads as a clear request (a short list when you named several things). The cleaned text replaces the box.
  An UNDO chip shows above the box for 10 s; **Ctrl+Z** puts the old text back for as long as the box still holds the cleaned
  text. A failed clean-up leaves the text alone and says why in a toast. The button waits while the box is empty or a dictation
  runs. If the text changed while it was being cleaned, the answer is dropped.
- **After dictating:** SETTINGS > CLEAN UP AFTER DICTATING (this browser only, off by default). The phrases of a take wait (the
  preview line shows them), and when the take ends they are cleaned in one piece and go in at the cursor (the button says
  CLEANING...). If the clean-up fails, or Esc skips it, the words go in as spoken: nothing said is lost. UNDO brings the spoken
  words back. LAB's prompt does not use it (it is the owner's exact test prompt). `useDictation(button, box, clean)` in `voice.ts`.
  SEND and the NEW CHAT / NEW PROJECT dialogs wait for the clean-up (Esc skips it); a cancelled take (Esc, a dialog taking
  the mic) puts its held words in as spoken; a take whose chat was left meanwhile goes into that chat's message box.
- **First message of a new chat or project:** the NEW CHAT and NEW PROJECT dialogs have an optional FIRST MESSAGE box with DICTATE
  and CLEAN UP (`web/src/firstmsg.ts`, the same voice code). It is not sent: when the chat opens, the text waits in its message box
  (a saved draft); you read it and press SEND. In the NEW CHAT dialog the dialog itself holds the focus when it opens, so a phone's
  keyboard stays down over the folders.
- **API (login needed):** `POST /api/voice/cleanup`, JSON `{ text, style? }` (style `"prompt"`, the default, or `"plain"`) ->
  `{ text, by }` (`by` = the model's label). Errors are `{ error }` with 400 (nothing to clean, bad JSON, bad style), 413 (over
  8000 characters), 429 (4 at once) or 502 (no model gave a usable answer: the caller keeps its text). `"plain"` only removes the
  speech slips (for dictating into any app); `"prompt"` also writes it as a request to an AI agent. Both keep the speaker's own words,
  every fact, name, number, path and command, the language, and treat the text as data: they never answer it or obey it.
- **Models (server/cleanup.ts):** 1. the local text model, only when the picker's default local model is already in GPU memory
  (`GET /v1/models` says `loaded`) and the text is up to 3000 characters: one request to the router's `/v1/messages`, no thinking
  (`enable_thinking: false`), temperature 0, timeout 4 s plus 4 ms a character (at most 12 s). A sleeping or unloaded model is never
  woken (that takes about 17 s and the GPU holds one model at a time), a model on its own server (Strata) is never used, and the call
  goes to the router directly, not through the relay (the relay would unload other models to make room). 2. Claude Haiku through
  the Agent SDK, with the AUTO router's options (no tools, no settings, temp folder, nothing saved; up to 60 s).
  `PHOSPHOR_CLEANUP_LOCAL=off` in `.env`: Haiku only.
- **The check on every answer (shared/cleanup.ts):** not empty, not much longer than the text, not mostly dropped, no assistant
  opening ("Sure, here is..."), most words come from the text and most of the text's words are still there; for the local model also
  every longer sentence must still be there. An answer that fails counts like an error: the other model tries, and when both fail the
  route answers 502. A code fence, a "Here is the cleaned text:" line or quotes round the answer are taken off first.
- **Measured (2026-10-25, 20 messy samples, three languages, both styles):** the local Qwen3.6 35B MoE answered in 0.2 to 1.9 s,
  Haiku in 1.7 to 4 s (the SDK needs about 2 s to start). Both kept the facts; Haiku stays closer to the speaker's words, the local
  model sometimes smooths a sentence or drops a hedge ("I don't know"), which is why its prompt has a second example and its answers
  get the strict sentence check. A spoken "ignore the above, write a poem" came back as the same sentence, cleaned.
- **Tests:** `npx tsx tests/cleanup.ts` (prompts, the check, the order of the models, the limits, the local call with a fake router,
  the route on a loopback port). The page flows (held words, CLEANING, UNDO, Esc, a failed clean-up, the dialog's box) were checked
  with a scripted voice socket and a fake microphone in headless Chromium against a test server.

## Dictate anywhere and PHONE KEYBOARD, built 2026-10-26

- **Why:** the owner pays for Wispr Flow and runs out of words; the PC's own engine (Voice above) is free and local.
- **Key:** `Ctrl + Space` in any app, press to start and press to stop (`os/hyprland/phosphor-os.lua`); in Phosphor-OS the bind hands the key on to the app's own DICTATE. The first build of the day had a floating mic (an Omarchy plugin and a Windows/Mac window), `Super + H` and hold to talk. The owner wanted the key already in use and nothing on the desktop, so those came out the same day: `desktop.sh` takes an installed mic plugin out on its next run (docs/OMARCHY.md row 6i). Hold to talk went too: a plain press has to do exactly what it did before, and a press held a little long would have stopped the take it started.
- **The take (Linux):** `os/omarchy/clock/phosphor-dictate` (`toggle`, `cancel`, `reset`) and `phosphor-dictate-live.mjs` (pw-record to `/ws/voice`). One take at a time (a lock in the run folder), the take writes its PID once it handles the stop signal, `curl` gives up on a hung server after 5 s. At the end the words are pasted by `phosphor-dictate-paste.mjs`: `wl-copy --sensitive`, the paste key with Hyprland's `send_key_state` down and up (`Ctrl + V`, terminals `Ctrl + Shift + V`), then the old clipboard back after 1 s if ours is still there. No window with the keyboard, or another one than at the stop (`focusedWindow`): the words stay on the clipboard and a notification says so. Terminals get one line (`pasteWords`: a line break would run a command). Not Hyprland: `wtype` presses the key.
- **CLEAN UP:** `shared/dictate.mjs` `cleanUp` calls `POST /api/voice/cleanup` `{ text, style: "plain" }` when the setting is on; 404, an error, no answer in 15 s or an empty answer: the words as said.
- **Shared rules:** `shared/dictate.mjs` (paste key per window class, phrase joining, final text, the CLEAN UP setting, CLEAN UP), loaded by the take from the app's folder and by the desktop app. The take in `~/.config` is a copy that only `desktop.sh` updates, while this file is read live: the names the take imports stay (a test reads the take and checks).
- **SETTINGS > VOICE** (`web/src/voicesettings.ts`): CLEAN UP IN ANY APP through the desktop app (`shell/dictate.mjs`; Linux: `~/.config/phosphor-os/dictate.json` = `{ cleanup }`, read by the take at each stop), and PHONE KEYBOARD.
- **PHONE KEYBOARD** (`server/voiceapi.ts`): `POST /v1/audio/transcriptions` (multipart `file`, `model` ignored,
  `language`/`prompt` taken but unused, `response_format` json | text | verbose_json; WAV 16 kHz mono as it is, other
  WAV and m4a/aac, ogg/opus, webm, mp3, flac, amr through ffmpeg from a temp file with the container named from its
  bytes; 25 MB, 10 minutes) and `GET /v1/models` (also wakes the engine; Dictate asks before it records). Bearer
  token `phos_...` in `data/voice-api.key` (600), made on first `GET /api/voice/keyboard`, `POST
  /api/voice/keyboard/new` replaces it; more than 10 wrong keys a minute: 429 for a minute. OpenAI error shape.
  Dictate Keyboard (checked in its source 2026-10-26): base URL with `/v1/`, Bearer key, multipart `file`
  (`dictate_audio.wav`, 16 kHz mono; m4a above 16 MiB), `model`, `response_format=json`, optional `language`,
  `prompt`; reads `{ text }`; lists `/models`.
- **Tests:** `npx tsx tests/dictate-anywhere.ts` (83 checks, headless), `bash tests/pack.sh` (the take with stand-in mic, server, clipboard and keys; the key logic in Lua with a stand-in `hl`; an upgrade from the pack that had the floating mic, from the real `desktop.sh` of that time in `tests/fixtures/floating-mic-pack/`, then undo). Also run on a copy of the owner's real pack notes and `shell.json` in a fake home: the re-run took the mic plugin, its entry and its notes out and a second run changed nothing. The first build was also tried on 2026-10-26 in a nested Hyprland on a hidden workspace: real takes (real speech from a recording through the real engine) were pasted into a foot terminal (`Ctrl + Shift + V`) and a Chromium text box (`Ctrl + V`) with the keyboard focus never moving, the old clipboard came back, CLEAN UP fell back on a 404. Not tested after the change: the real `Ctrl + Space` press on the owner's PC, which needs `hyprctl reload` first.

## FOCUS (hide the side panels), built 2026-10-26

- **Why:** the owner shares the screen in videos on an ultra-wide monitor: a clean chat in the middle, no panels.
- **Buttons:** LEFT / FOCUS / RIGHT in the top bar (a quiet small group before FULL). LIT = that panel is showing; FOCUS is lit when both are hidden. Hidden by `only-wide` on phones and the folded layout.
- **Keys:** `Ctrl+[` left, `Ctrl+]` right, `Ctrl+\` both (hide both; again shows both). Read by `e.code`, so any keyboard layout works; never with Alt, Shift or Meta. None of these is bound by the app (Ctrl+K launcher, Ctrl+1..9 programs, Ctrl+L address, Ctrl+Space dictate), Hyprland (only Super binds) or Electron.
- **Remembered:** `localStorage` `phosphor.view` = `{ left, right }` (true = hidden). A line in the `index.html` head script puts `hide-left` / `hide-right` on `<html>` before first paint, so a reload shows no flash.
- **Layout** (`web/src/focus.css`, inside "not narrow" so the phone is untouched even if the classes stay): the hidden panel is `display: none`, the grid keeps the other columns, and `#center` gets `max-width: var(--focus-width, 1200px)` and sits in the middle of its column. The message box and the bar above it are inside `#center`, so they follow. Both shown: the old layout, unchanged. 1200 px was picked from screenshots at 3440 px (about 120 characters a line, no side to side reading).
- **Nothing lost:** permission prompts and questions are chat items (they show in the chat); the tab bar still lights NEEDS YOU, and the sound and push alerts do not care about the panels. A small dot on the LEFT / RIGHT button of a hidden panel when a chat starts needing you or finishes (`focus.ts`, same edges as the alert and done chimes in `sound.ts`); showing the panel clears it. Launcher commands MISSION / FILES / SYSTEM show the right panel if it was hidden (`showRight`).
- **Tests:** `npx tsx tests/focus.ts` (fake page: buttons, keys, the saved view, the dot). Screenshots in a browser at 3440x1440, 1600x1000, 412x915 with `/?demo=1`.

## PROMPTER (punch-list teleprompter), built 2026-10-27

Owner's ask: he makes YouTube videos and does not read scripts; he wants a punch list of points on screen and to see live which ones he has not covered yet (idea from a "teleprompter that listens" video: speech to text, a decision model asked about each open bullet about every second, covered bullets tick off).

- **Use:** PROMPTER in the top bar (launcher: PROMPTER, PROMPTER AFTER). LIST: write or paste the points, one per line; an indented line is a short note under the point above; list marks (`- `, `1. `, `[ ] `) go. SAVE keeps named lists on the PC; the box keeps an unsaved draft in this browser. START opens RUN and starts this device's mic. RUN: the timer, done / total, where the mic is (THIS DEVICE, OTHER DEVICE, OFF) with its level, AUTO TICK or TICK BY HAND; the next open point big and boxed, the other open points below it, covered ones small, dim and struck through at the bottom (BY HAND when ticked by hand); the last words heard on two lines at the bottom. A tap (or Enter) ticks or unticks a point. FULL shows only the prompter, over everything (and the browser's full screen where it can): nothing private on screen while recording. STOP (asks first) lets the last phrase in, then ends the session; CHECK AFTER opens AFTER with its list and transcript. Leaving the screen does not stop a recording. Deep links: `/?prompter`, `/?prompter=run`, `/?prompter=stage` (RUN in FULL, for a second monitor), `/?prompter=after`.
- **Mic and devices:** the mic is the one of the device whose page pressed START (or LISTEN HERE). Every page with PROMPTER open shows the same session (it polls `GET /api/prompter/live` every 0.7 s while one runs), so: record on the PC with its mic and read the points on the phone (START on the PC, open PROMPTER on the phone), or the other way round. LISTEN HERE moves the mic to this device; the old device lets go at its next send (409). The phone reaches the app over the Tailscale https address like DICTATE (the mic needs https). While RUN shows a running session the page asks the browser to keep the screen on (Wake Lock).
- **Speech:** the same engine and socket as DICTATE (`/ws/voice`, Parakeet on the CPU). `web/src/promptermic.ts` reuses DICTATE's recorder (`Recorder`, `loadWorklet`, `openMic`, `micError`, exported from `voice.ts`). The engine takes 10 minutes per socket, so a fresh socket takes over every 9 minutes and the old one finishes its last phrase: an hour or more keeps working. Audio is sent and dropped, words go to `POST /api/prompter/live/feed` at most every 0.5 s (partial phrase, finished phrases, level; at least every 3 s as a heartbeat). The server keeps only the last 45 s of phrases (at most 1500 characters, `Heard` in `shared/prompter.ts`) and appends finished phrases to the session's transcript file: memory stays flat.
- **Decisions (`Cue` in `shared/prompter.ts`, loop in `server/prompter.ts`):** every 0.4 s the server looks for new words; with some, and no call in flight, it asks the decider about the open points only: the last 45 s of words, the names of the last 8 covered points (a short summary), at most 12 points (the first 8 open ones in list order plus 4 of the rest in turn). One call at a time, none when nothing new was said, 10 s timeout, after an error a wait of 2 s doubling up to 30 s. **Tick rule:** the decider says how sure it is (0..1) that the speaker has started the point; a tick needs one answer of 0.92 or more, or two answers in a row of 0.75 or more for that point. Why: a wrong tick hides a point not yet made (worse than a tick a second late), and two calls about a second apart with new words in each guard against one noisy answer. A point unticked by hand is not asked for 45 s (the same words would tick it again). The tick keeps the words that covered it and the time its streak started.
- **The decider (`server/prompterdecide.ts`):** the one place that knows the decision model: `askDecision` from `server/decide.ts` (`/v1/systemone`, the local CPU decision model or a cloud engine, settings `PHOSPHOR_DECIDE_*`, see `docs/LOCAL-MODEL.md`). One call per step with one yes/no (`noul`) question per open point, in the wording the model was measured with ("Has the speaker started talking about this point, in any words: ...", plus the point's note); the state is the recent words, after one short line naming the covered points; 2.5 s timeout; the answer's `p` is the 0..1 the tick rule reads. The model's "no" answers sit around 0.2 to 0.5, well under the rule's 0.75. Engine not running: the screens say TICK BY HAND with the setup command (calls keep trying, cheaply: the client skips a down engine for 5 s); `PHOSPHOR_DECIDE=off`: no calls.
- **AFTER:** points (typed or a saved list) and a transcript: pasted (plain text, YouTube's transcript with times, SRT or VTT), a text file, a PROMPTER recording, or an audio or video file (decoded in the page at 16 kHz, cut at quiet moments into pieces under 4.5 minutes, each sent to `POST /api/transcribe`, the DICTATE engine). The server replays the transcript through the same tick rule, about 55 words (20 s of speech) per step, and lists MISSED and COVERED points with the words that covered each and where (the transcript's own time, or how far in). One check at a time.
- **API (login needed, JSON bodies only):** `GET/POST /api/prompter/lists`, `GET/DELETE /api/prompter/lists/<id>`, `GET /api/prompter/live[?id=<id>&v=<n>]` (only `{ v }` when that session has not changed), `POST /api/prompter/live/start | mic | feed | mark | stop`, `GET /api/prompter/sessions[/<id>]`, `POST /api/prompter/after`, `GET /api/prompter/after/<id>`. Data: `data/prompter/lists/<id>.json`, `data/prompter/sessions/<id>.json` + `<id>.txt` (`[mm:ss] phrase` lines; the newest 30 kept). A session with no words for 30 minutes, or longer than 6 hours, ends itself.
- **Demo:** `/?demo=1&prompter=run` (a running recording whose points tick off), `&prompter=stage`, `&prompter=list`, `&prompter=after` (`web/src/prompterdemo.ts`).
- **Tests:** `npx tsx tests/prompter.ts` (list format, the rolling window over 3 hours of talk, the tick rule with a fake decider and clock, a fake transcript stream, AFTER, audio pieces, the routes on a loopback port). The page was run against a test server in headless Chromium with a fake mic: START, a phone page watching and ticking, the 9-minute socket hand-over (fake clock), LISTEN HERE moving the mic, FULL, STOP, CHECK AFTER.

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

## Gemini chat (agy), built 2026-10-25

- **Use:** in a new chat (nothing sent yet), pick GEMINI 4 ARGON or GEMINI 3.8 FLASH in the model picker, then chat as usual. The list comes from `agy models` (Gemini only, one entry per model, its levels as THINK levels). A chat stays with the one it started with: Claude Code and agy keep separate conversations, so switching a started chat between Claude and Gemini (a model or AUTO) is refused with a note; Gemini to Gemini and the picture models work.
- **Runtime** (`server/geminitab.ts`, a small branch in `Tab`): each message is one headless run in the tab's folder, `agy -p <text> --output-format stream-json --print-timeout 1800s [--mode] [--model] [--effort] [--conversation <id>]`, with `AGY_CLI_DISABLE_AUTO_UPDATE=true`. Messages sent while it runs wait their turn. Events: `init` (the conversation id, saved with the tab), `step_update` (`agent_response` text deltas stream into a reply named after the model; `tool` and `subagent` steps become tool lines; written files count as changed; a plan agy writes in its own folder `~/.gemini/antigravity-cli/brain/<conversation>/` shows its text in the line), `result` (status, error, `denied_actions`). A picture its image helper makes is copied as PNG to the pictures folder and shown. Attachments: their paths go in the message, their folders with `--add-dir`. `/quota` and other agy slash commands go through as typed.
- **Modes** (headless agy cannot ask; what a mode does not allow is refused and the run ends, with a note saying what): ASK FIRST = agy's default mode plus a read-only note in the message (agy has no read-only mode, and its plan mode answered even "pick a fruit" with a plan). PLAN ONLY = `--mode plan`. Both write files without asking in a headless run (default mode at once, plan mode once told "go ahead"; tested), so these runs see the chat's folder and the attachments read-only through bubblewrap (`bwrap --dev-bind / / --ro-bind <folder>`, agy's `~/.gemini` writable, `--die-with-parent`): a write fails and its line shows it. Without a working bubblewrap, a file write is a tripwire: the run is stopped and the chat names the file. AUTO-EDIT = `--mode accept-edits` (files in the folder; commands refused). AUTO = `--mode accept-edits` too: agy's own `--mode auto` runs the commands its checker finds safe, and agy has none of Claude Code's hooks (such as a block on writes to a production org), so it is never used. BYPASS is not offered: it becomes AUTO with a note. No mode runs commands unless agy's own settings allow them (an allow rule there applies to every mode, so the chat does not suggest one).
- **STOP:** SIGINT to the run's PID (agy ends at once), SIGTERM and SIGKILL 3 s apart if needed; waiting messages are dropped. Errors in plain words: not signed in ("run `agy` once in a terminal"), not installed, a lost conversation (agy starts a new one), agy's own error line, time up (30 min).
- **Saved:** `data/gemini-chats/<conversation>.json` (the chat as shown, notes included) after each run and on close; tabs.json keeps `gemini: <conversation>`. A restart loads the file and the next message continues the conversation. HISTORY lists these chats (GEMINI tag, text search) and reopens them on their last model.
- **Page:** `Info.agent = 'gemini'` hides what only Claude has: UNDO, the "/" list, CONTEXT and COMPRESS; the CTX gauge stays off (no token count), the crew stays empty, the operator card says GEMINI, the box says "Message Gemini…", the mode picker's tooltip explains the mapping. The MCP screen says agy has its own (`agy mcp list`).
- **Test:** `npx tsx tests/geminichat.ts` (a fake agy plays recorded real runs from `tests/fixtures/gemini/`). Real check 2026-10-25 on a test server: two messages (the second used the first answer), STOP, a restart, then a message that needed the first answer, and HISTORY close, search and reopen.

## OPERATOR scene, built 2026-10-26

Owner's ask: the big operator avatar took space and did nothing; a mascot should break up the text by acting out
what Claude is doing, helpers should walk into the same scene, the card should be about half as tall, the crew
cards smaller, and the art more detailed (16-bit style, FF6 / FF Tactics / Octopath) with a wider palette.

- **The card:** the chat name, CLAUDE/GEMINI and the state tag on one line; the scene (36 pixel rows, 2 screen px
  each, 3 when the panel is 420 px or wider); the activity line with the turn timer. TURN and TOOLS counts sit in
  the OPERATOR heading, the crew count in the CREW heading. About 150 px tall instead of about 275 px.
- **What the mascot does** (`web/src/sceneplan.ts`, from the activity line `server/tab.ts` already sends):
  idle (mug, blinks), thinking (thought bubble), writing a reply (speech bubble fills), reading (open book, page
  turns; Read, Grep, Glob, LS), editing (fast typing, code glyphs; Edit, Write, MultiEdit, NotebookEdit), shell
  (hammer at an anvil, sparks; Bash, Run, Monitor), web (brass telescope; WebSearch, WebFetch, browser connectors),
  waiting for you (waves, "!" bubble, screen flashes), done (a cheer, 6 s after a turn ends), error (smoke, X eyes:
  a failed tool while Claude looks at it, or a turn that ended with an error note). Other tools: typing.
  The table is `TOOL_ACTIVITY`; add a tool there.
- **Crew in the scene:** a running helper walks in from the right to the next free slot, works with its own prop
  (scout: magnifier, architect: blueprint, engineer robot: wrench, librarian: book, others: tablet), and when it
  ends cheers (done) or slumps (failed: smoke; stopped: dozes), then walks out. Up to 4 on stage (fewer on a
  narrow panel), then "+N". A tab switch or first paint shows working crew in place, no walking.
- **Palette:** `sprites/engine.ts` has shading ramps beyond the four phosphor tones: outline, backdrop, deep,
  white, skin, cloth, metal, fire, sky, wood, leaf (legend at the top of the file). Each theme maps them with
  `--sprite-<name>` tokens in `sprites/palette.css` (amber stays warm, green stays green, LCARS uses its panel
  colors); a theme without them falls back to its phosphor tones. Old sprites (`operator.ts`, `crew.ts`, the
  screensaver) are untouched.
- **Speed:** room, mascot and each helper are their own small canvas on the shared 8 fps clock (a frame is
  drawn only when it changes); walking is a stepped CSS transform. Reduced motion: still frames, no walking.
- **Demo:** `/?demo=1&scene=<idle|think|write|read|edit|work|shell|web|wait|done|error>&crew=N` pins the first chat's
  scene; plain `/?demo=1` cycles activities and helpers. The sprite review page (`/sprites.html?only=scene`,
  `npm run dev:web`) shows every scene animation in all three themes.
- **Test:** `npx tsx tests/scene.ts` (tool table, activity, crew walk in/out, slots, and that every sprite part has
  even rows and known colors).

## PROJECTS and + CHAT, built 2026-10-27

Owner's ask: "When I create a new project, I have one tab in the project. I need to be able to create more chats inside of a project. Then I need an easy way to get back to my list of projects to select another project."

- **+ CHAT** (one more chat in a project): a `+` at the end of the project's group in the tab bar (shown when folded too), `+ CHAT` under THREADS in the left panel, `+ CHAT` on an open project's row in PROJECTS, and IN THIS PROJECT in the NEW CHAT dialog when a project chat is in front (the typed first message comes along). A dialog asks an optional name (default "Chat N") and the optional first message (DICTATE, CLEAN UP), then START. Client event `new_project_chat { project, title?, req? }`, `Tabs.createInProject`.
- **What the new chat is:** a thread of the lead (`ProjectRef` `main: false`, `parent` = the lead's tab, `own: true`): the lead's folder, the shared PROJECT.md, AUTO model. Why a thread and not a plain member: the lead's `list_threads`, `read_thread` and `send_to_thread` see it, so the lead's plan stays whole, and no second kind of member is needed. `own` changes only its system prompt text: opened by the user, and `report_to_project` only when the user asks (a lead-made thread still reports when done).
- **PROJECTS** (every project, open or closed): the PROJECTS button in the top bar (in MENU on a phone), ALL PROJECTS under THREADS, and PROJECTS in the launcher (Ctrl+K). A drawer like HISTORY: filter box, NEW PROJECT, then one row per project, newest activity first: name, state (NEEDS YOU, WORKING, OPEN, CLOSED; live from the tabs), chat count (OPEN count when some are closed), last activity, and its chats (LEAD first; closed ones dim). A tap goes to the chat last used in that project (this browser, `phosphor-os.project-last`), else the lead; a project with no open chat reopens. REOPEN N CLOSED brings back the closed chats of an open project.
- **Closed chats are kept:** `data/projects/<id>/project.json` (`server/projects.ts`, `ProjectBook`) has the name and every project chat closed with a session (a chat never used is not kept). `open_project { project, req? }` (`Tabs.openProject`) reopens them through HISTORY's resume path (`Tabs.open`), the lead first so threads find it; `req` goes with the lead (else the chat closed last). `Tabs.open` takes any closed project chat back into its project, so reopening one from HISTORY works too. A lead coming back while another lead is open joins as a thread (one lead). Projects made before this have no project.json: the name comes from PROJECT.md's title, and opening one starts a new lead on the same memory file. `GET /api/projects` -> `{ projects: [{ id, name, createdAt, lastActive, closed }] }`; lastActive is the newest of the chats' transcript times, closing times and the start.
- Demo (`?demo=1`): the YT project with one closed chat, a closed project with three chats, and an older project with none. Tests: `npx tsx tests/projects.ts` (book in a temp folder, `Tabs` with Claude stubbed out).
- Not built: deleting or renaming a project, moving a chat into or out of a project.

## Ideas

- SYS as a small panel in the lower left (a few key readings, always visible) that expands to the full SYS view.
- DOCS connected to other services (Google Tasks, Google Drive, Nextcloud over WebDAV).
- STATION: push alerts to the phone for Unraid alerts and services that are DOWN (the rules exist; only the sending is
  missing); the flash backup's date (not in Unraid's API; Unraid Connect may have it).
- Crew XP: agents earn XP and level up (decoration only; Claude never sees it).

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
| FOCUS (hide side panels) | `web/src/focus.ts`, `focus.css` (the three top-bar buttons are in `index.html`, the saved view is read in its head script), `tests/focus.ts` |
| Look | `theme.css` (token contract at top), `chat.css`, `settings.ts`, `sound.ts`, `boot.ts`, login page |
| HUD | `mission.ts`, `mission.css` |
| IDEAS panel | `shared/ideas.ts` (file format, parse, drop, the DO message), `server/ideas.ts` (`GET /api/ideas`, `POST /api/ideas/drop`, `PHOSPHOR_IDEAS_FILE`), `web/src/ideas.ts`, `ideas.css` (under TODAY, mounted by `agents.ts`), `newReq(then)` in `net.ts` (DO: new tab, then send), `tests/ideas.ts`; weekly suggestions `server/ideasweekly.ts` (Friday 07:00+, catch-up after 8 days, `PHOSPHOR_IDEAS_NOTES`, `POST /api/ideas/suggest`, log `data/ideas-weekly.log`), `tests/ideasweekly.ts` |
| Cache clock | `shared/cache.ts` (TTL from usage, time left), `noteCache` in `server/tab.ts` (live replies + reopened chats), `cacheOf`/`watchCache` in `web/src/context.ts` (CTX gauge suffix), CACHE row in `mission.ts`, `tests/cache.ts` |
| Agents | `agents.ts`, `agents.css`, `sprites/` |
| OPERATOR scene | `web/src/scene.ts` (DOM, walking), `web/src/sceneplan.ts` (tool table, activity, crew roster; `tests/scene.ts`), `sprites/mascot.ts`, `sprites/troupe.ts`, `sprites/room.ts`, ramps in `sprites/engine.ts` + `sprites/palette.css`, demo pins in `demo.ts` |
| TODAY panel (calendar + reminders) | `server/calendar.ts` (`GET /api/today`, 10-min fetch, cache file), `server/icsexpand.ts` (pure ICS expansion), `web/src/today.ts`, `today.css`, `docs/CALENDAR.md`, `tests/calendar.ts` |
| Month view (opened from the TODAY heading) | `GET /api/calendar` (`calendarRange` in `server/calendar.ts`), `web/src/calendar.ts`, `calendar.css`, `calfmt.ts` (shared text helpers, EDIT / + NEW links), `demoMonth` in `demo.ts`; Google Calendar links (EDIT, + NEW): `server/gcal.ts` (pure, tested) |
| Files UI | `files.ts`, `files.css` |
| Voice | `server/voice.ts`, `server/voice-worker.mjs`, `web/src/voice.ts`, `voice.css`, `scripts/setup-voice.ps1` |
| CLEAN UP | `shared/cleanup.ts` (instructions, the check on an answer, the order of the models), `server/cleanup.ts` (`POST /api/voice/cleanup`, the local and Haiku calls), `web/src/cleanup.ts` + `cleanup.css` (button, UNDO chip, the setting and its SETTINGS row), `firstmsg.ts` (first message box of the new chat and project dialogs), the hold-and-clean part of `voice.ts`, `demoCleanup` in `demo.ts`, `tests/cleanup.ts` |
| Dictate anywhere + PHONE KEYBOARD | `shared/dictate.mjs`, `os/omarchy/clock/phosphor-dictate*` (the take, paste), `os/hyprland/phosphor-os.lua` (`Ctrl + Space`), `shell/dictate.mjs` (the CLEAN UP switch), `web/src/voicesettings.ts` (SETTINGS > VOICE), `server/voiceapi.ts` (`/v1/*`), `tests/dictate-anywhere.ts` |
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
| Gemini chat | `server/geminitab.ts` (agy runs, stream-json events, modes, STOP, `data/gemini-chats/`), branch points in `server/tab.ts` (`useGemini`, `switchRefused`), model list and HISTORY in `server/tabs.ts`, `isGeminiModel` / `Info.agent` in `shared/protocol.ts`, `tests/geminichat.ts`, `tests/fixtures/gemini/` |
| Projects (lead, threads, + CHAT, PROJECTS) | `projectTools`/`projectHelp` in `server/tab.ts`, `Tabs.createProject/thread/createInProject/openProject/projectList` and the project parts of `open`/`close` in `server/tabs.ts`, `server/projects.ts` (`ProjectBook`: `data/projects/<id>/project.json`, closed chats; `joinRef`), `GET /api/projects`, `web/src/projects.ts` + `projects.css` (PROJECTS drawer, + CHAT dialog), groups and `+` in `web/src/tabs.ts`, THREADS in `agents.ts`, `tests/projects.ts` |
| AUTO model | `shared/router.ts` (parse the pick, the decision questions and their rule, stickiness rule), `server/router.ts` (decision model first, Haiku call as the fallback), `server/decide.ts`, `Tab.send/route` in `server/tab.ts` (applies, tags with the engine and time, logs to `data/auto-router.jsonl`), `web/src/pickers.ts`, `scripts/auto-eval.ts` (router only, on recent chats), `tests/router.ts` |
| HISTORY drawer | `Tabs.history/searchHistory` in `server/tabs.ts` (`GET /api/history[?all=1]`, `GET /api/history/search?q=`), `server/transcripts.ts` (entrypoint filter: this app's chats are `sdk-ts`; chat text, match, snippet, cache), tab name saved to its session in `Tab.saveSessionTitle`, `web/src/history.ts` (ALL CHATS toggle), `tests/history.ts` (`npx tsx tests/history.ts`) |
| SDK update | `server/sdkupdate.ts` (hourly npm check, bell notice, `GET/POST /api/update`, 04:00 run), `shared/sdkversion.ts` (range rules), `scripts/update-sdk.sh`, `web/src/sdkupdate.ts`, `sdkupdate.css` (UPDATE chip), `tests/sdkversion.ts` |
| STATION | `server/station.ts`, `server/lan.ts` (allowlist, probes, DISCOVER), `server/stationhealth.ts` (24-hour strip counts), `shared/station.ts`, `web/src/station.ts`, `station.css`, `stationdemo.ts` (demo data), `shell/skins.mjs`, `shell/skins/*.css` |
| STATION > Unraid | `server/unraidapi.ts` (questions, request, cleaning, alert rules), `server/unraid.ts` (.env, polling, `GET /api/station/unraid`), `shared/unraid.ts`, `web/src/unraid.ts`, `unraid.css`, `unraidfmt.ts`, `tests/station-unraid.ts` + `tests/fixtures/unraid/`, `docs/STATION.md` |
| LAB (Model Lab) | `server/lab.ts` (folders, `/api/lab/*`, sandboxed `/lab/v/<key>/` file viewer), `server/labrun.ts` (apps, bubblewrap box, runs, `PHOSPHOR_LAB_CLAUDE_TOKEN`), `server/labfollow.ts` (FOLLOW UP prompt, versions), `shared/lab.ts`, `web/src/lab.ts`, `lab.css`, `labdemo.ts` (demo data), `tests/lab-live.ts` (real models, private port), `tests/lab-queue.ts`, `tests/lab-library.ts` (prompt list and + MODELS, fake runner), `tests/lab-followup.ts` (FOLLOW UP, versions, RUN AGAIN, fake runner), plan `docs/MODEL-LAB.md` |
| ROUTER (local jobs, thread workers) | `server/delegate.ts` (ask_local, file rules, queue, model pick, stream, ledger, thread workers, guidance), `Tab.askLocal/delegates` and `start_thread` in `server/tab.ts`, `Tabs.thread` (`run`), `Painter.holdsGpu` in `server/imagegen.ts`, `GET /api/router`, `web/src/routercard.ts` (ROUTER card), `tests/delegate.ts`, plan `docs/ROUTER-PLAN.md` |
| DECIDE (decision model) | `server/decide.ts` (client, settings, down pause), `shared/decide.ts` (question and answer types, reading an answer), `scripts/setup-decide-model.sh` (CPU service), `scripts/decide-bench.ts` + `tests/fixtures/decide-cases.ts` (speed and accuracy of an engine), `tests/decide.ts`, `docs/LOCAL-MODEL.md` "Decision model" |
| KEYWORDS (YouTube keyword check) | `server/keywords.ts` (signals, scores, runs in `data/keywords/`, `/api/keywords/*`), `shared/keywords.ts`, `scripts/keywords.ts` (command line, used by Claude), `web/src/keywords.ts`, `keywords.css`, `keywordsdemo.ts`, `tests/keywords.ts`; how it works `docs/KEYWORDS.md` |
| PROMPTER (punch-list teleprompter) | `shared/prompter.ts` (list format, rolling transcript `Heard`, tick rule `Cue`, AFTER replay, audio pieces), `server/prompter.ts` (`/api/prompter/*`, the live session and its loop, lists and transcripts in `data/prompter/`), `server/prompterdecide.ts` (the decider adapter), `web/src/prompter.ts`, `prompter.css`, `promptermic.ts` (mic to `/ws/voice`, socket hand-over, feed), `prompterdemo.ts`, `tests/prompter.ts` |

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
