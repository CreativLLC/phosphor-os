# Model Lab: plan

Status: built 2026-10-24 (first version); prompt LIBRARY and + MODELS added 2026-10-26; FOLLOW UP and versions added 2026-10-26. Runs Claude (Claude Code), GPT (Codex), every OpenCode Go model (opencode; Gemini, Grok and Kimi included), Gemini on the Google AI Pro plan (Antigravity, `agy`) and the local models, each in the box below. Not yet: OpenRouter, video mode extras, nightly backup. Live test with real models: `npx tsx tests/lab-live.ts` (private port and folder). Written 2026-10-23; the owner writes every prompt, the lab has no built-in tests.

Goal: write a prompt, tick the models to send it to, and run it on all of them at once. See every result in one place, rate each one, and keep each result in its own folder. Archive or delete old ones. Look back at all of them years later. Also good for recording videos.

## 1. Words

- **Test**: one prompt sent to some models at the same time. It has its own folder.
- **Model**: one app + one model + one account. Example: "Kimi K3.1 Pro · opencode · OpenCode Go".
- **Result**: one model's answer to one test: its reply, the files it made, its log, and your stars.

## 2. How a model gets in

Each model runs in its maker's own app (the "home app"), the way a person would use it. Each app has a mode that runs with no person (headless) and gives JSON output. Checked on this PC on 2026-10-23 from the help text only; no test run yet.

| Models | App and headless command | Account |
|---|---|---|
| Claude (Opus, Sonnet, Haiku) | Claude Code: `claude -p --output-format stream-json` | Claude plan |
| Gemini (Argon, Flash) | Antigravity: `agy -p --output-format stream-json --model <id>` | Google AI Pro |
| GPT | Codex: `codex exec --json -C <dir> -m <model>` | ChatGPT plan (Free has small limits) |
| Kimi, GLM, DeepSeek, Qwen, MiniMax, Grok, small GPT and Gemini models | opencode: `opencode run --format json -m <provider/model> --auto` | OpenCode Go |
| Almost any other model | opencode with an OpenRouter key | pay per use |
| Local models (docs/LOCAL-MODEL.md) | Claude Code through the local relay | free, one at a time (GPU) |

The model list in the lab comes from the apps themselves (`agy models`, `opencode models`, Codex and Claude model lists), so a new model shows up when its app has it. The owner hides the ones not wanted.

Why home apps and not one shared app:

- The Claude, ChatGPT and Google plans work only in their own apps. One shared app would mean pay-per-use for those models.
- The app is shown on every result, so it is always clear what ran.

Later, "same app" tests: opencode can drive every OpenCode Go and OpenRouter model, and `agy` drives Gemini and Claude on one plan. Then only the model changes.

Notes:

- Gemini CLI's Google sign-in stopped working for personal accounts in June 2026. Use `agy`.
- `agy` (2026-10-24): its Google sign-in is one item in the desktop keyring (Secret Service, `service=gemini username=antigravity`), and the keyring holds every other saved password too, so the box never reaches it. The box runs `dbus-run-session` with its own `gnome-keyring-daemon` (an empty keyring, throwaway password), the runner reads the one item with `secret-tool lookup` and hands it in on stdin, `secret-tool store` puts it in the box keyring, then `agy -p ... --output-format stream-json --dangerously-skip-permissions`. Only the `agy` program file is shown to the box, at /opt/agy/agy. `agy models` lists each model once per effort (`gemini-4-argon-high`); the lab shows one entry and passes `--effort`.
- Effort (2026-10-24): one setting per test (APP DEFAULT, LOW, MEDIUM, HIGH, EXTRA HIGH, MAX). Claude Code and agy take `--effort`, Codex `-c model_reasoning_effort=<level>`, opencode the model variant `provider/model#<level>`, local models `--effort` (the local relay turns it into the model's own). The levels each model has come from its app (Codex models_cache.json, the models.dev catalog's `reasoning_options`, agy's model names); a model without the asked level gets the nearest (the higher on a tie), and result.json `effort` says what it ran at.
- Web pages a model makes (2026-10-24, after the first real test): the box has Node.js on PATH (from `mise which node`), so models can build. The viewer picks a built page first (`dist/`, `build/`, `out/`), then any page that runs as it is. A project whose page only loads source (`/src/main.tsx`) gets `npm install && npm run build` in the box after the run (Vite with `--base=./`), output in `build.log`; BUILD THE PAGE on the card does the same. The viewer sends `Access-Control-Allow-Origin: *` (a sandboxed page is another origin, so module scripts and `crossorigin` style sheets need it), points root paths (`/assets/...`) at the site's own folder, and puts an in-memory localStorage in front of each page (a sandboxed page has none).
- Ranking (2026-10-24): RANK view on a test puts the finished results in a best-to-worst order (▲ ▼, drag on a PC); each result.json keeps its `rank` (1 = best, 0 = none). The winner in HISTORY and the WINS chart is the #1 when a test is ranked, else the most stars. REVEAL works once all finished results have stars or all are ranked. RUN AGAIN on a finished result runs that model again from scratch, always with at least a 1-hour limit (since 2026-10-26 on DONE results too, and the old result is kept as a version: section 5). A run the time limit stops counts as done (`timeUp`, card says TIME UP) when it made files: same limit for all, so what it had by then is its result. Nothing made = failed. Rating (2026-10-26): a result that stopped at the plan limit, failed late or was stopped can still get stars and a place in the ranking when it made a web page (the owner: if it looks done, it can be rated). Those stars are optional: REVEAL waits only for DONE results (2026-10-27: limit runs left a half-made page and kept a test blind). Older Claude models (2026-10-26, to test against local models): Opus 5, Sonnet 5, Opus 4.5 (effort low to high) and Sonnet 4.5 (no effort; retires 2026-11-30), on the same Claude plan. Gemini comes only as Antigravity offers it (Gemini 4 Argon, Gemini 3.8 Flash).
- OpenCode Go models marked "requires Global regions" (DeepSeek V4.1 Flash) fail until Global is picked in the workspace's Privacy settings at opencode.ai.
- opencode in the box: its sign-in lives in its own database, so the runner exports only the one provider's credential (`opencode auth export`) and imports it on stdin into the box's fresh data folder. Its bundled model list is old; the runner keeps a copy of the models.dev catalog in `data/lab/.cache/models.json` (refreshed every 6 hours) and points `OPENCODE_MODELS_PATH` at it.
- OpenCode Go endpoints (its docs): Kimi, GLM and DeepSeek are on the OpenAI format only. The Anthropic format has only Qwen, MiniMax M3 and Claude Haiku. So "Claude Code + Kimi through Go" needs a translator. Not planned.
- OpenCode Go terms: it is for coding agents. Direct API calls must send their own user agent and an `x-opencode-session` header. Using the opencode app avoids this.

## 3. The clean room (fair and safe)

Every result:

- starts in a new empty folder;
- runs inside bubblewrap (`bwrap`, installed): a box where HOME is a fake empty folder. The app sees only its result folder, its own sign-in file and the programs it needs. It cannot see SSH keys, cloud logins, synced folders or other projects;
- runs in its own systemd scope with a memory limit (`systemd-run --user --scope -p MemoryMax=...`), so a big build cannot take the server down with it;
- gets no skills, no memory, no MCP servers, no CLAUDE.md or AGENTS.md: each app starts with a fresh config folder that holds only its sign-in;
- has a time limit (set per test: 5, 10 or 30 min, 1 or 2 hours; default 1 hour since 2026-10-26, when 30 min was too short for big jobs). The runner stops it by PID after that;
- has network access, because the app must reach its model.

Sign-in for each app (check all of this in phase 0):

| App | Fresh config | Sign-in |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` in the box | a long-lived token from `claude setup-token`, in `.env` as `PHOSPHOR_LAB_CLAUDE_TOKEN`; the runner passes it into the box as `CLAUDE_CODE_OAUTH_TOKEN`. Its own name, so the main chats never pick it up. Never copy the main credentials file: a token refresh in the box could sign out the main app. |
| codex | `CODEX_HOME` in the box | the real `~/.codex/auth.json` bound read-write into it, so a refresh writes back to the one file |
| agy | fake HOME, its own D-Bus and keyring | the one keyring item, copied in on stdin (see Notes) |
| opencode | `XDG_CONFIG_HOME` and `XDG_DATA_HOME` in the box | the real `auth.json` bound in |

Why the box matters: Codex, agy and opencode do not have Claude Code's hooks. In auto-approve mode a model can run any command.

## 4. Folders (made to last for years)

On the Linux disk, gitignored, in `data/lab/`. Not in a synced folder: models can make big junk folders (`node_modules`), and syncing those is slow.

```
data/lab/
  tests/
    2026/
      2026-10-23-retro-snake-game/        date + a short name from the prompt
        test.json                          prompt, title, models, time limit, schema version
        prompt.md                          the prompt, as plain text
        kimi-k3.1-pro--opencode/
          result.json                      app + app version, exact model id, account, start, end, state, tokens, cost, stars, note
          reply.md                         the model's final answer, as plain text
          log.jsonl                        the app's raw JSON stream
          files/                           everything the model made
          prompt.md                        after a FOLLOW UP: the exact prompt that run got (LOG shows it)
          versions/                        kept before each FOLLOW UP or RUN AGAIN (section 5)
            1/                             the result.json, reply.md, log.jsonl, prompt.md and files/ it had then
        gpt-6--codex/
          ...
  archive/                                 same layout; ARCHIVE moves a test folder here
```

Rules that keep it readable a year from now:

- Everything is plain files: Markdown and JSON. A test folder still makes sense with no lab and no Phosphor-OS.
- Each `result.json` keeps the exact model id, the app version and the date, so it is always clear which model ran (names like "latest" change over time).
- Each JSON file has a `schema` number. A newer lab reads old files; it never rewrites them in a new shape.
- The folder is the truth. Moving a test folder into `archive/` by hand is the same as the ARCHIVE button. Deleting it by hand is the same as DELETE. The lab reads the folders again when it opens.
- Stars and notes live in `result.json`, inside the result folder, so they move with it. A version keeps its own copy, so the stars a result had before a follow-up are never lost.
- Cost comes from the token counts in each app's JSON. Plan results show "plan" and $0; pay-per-use results show dollars.

## 5. Screens

A new program, **LAB**: next to DOCS on the program bar, and in the launcher on the phone.

1. **NEW TEST**: a big prompt box, an optional title, the model list with ticks (it remembers your last picks), a time limit, and START. All ticked models start at the same time (local models one at a time). **LIBRARY** (next to DICTATE) opens every prompt used before, from HISTORY and ARCHIVE, newest first, one row per distinct prompt text: the title (of the newest test that used it), the start of the prompt, how many tests used it and the date of the last. A filter box searches titles and prompts. A pick fills the title and the prompt (both stay editable; if the box already has other text, it asks before replacing it). The models, effort and time limit stay as they are: pick them and START as usual, which makes a new test. This is how the same prompt is tested again later on new models.
2. **TEST**: one card for each model, side by side. While it runs: state, timer, tokens. When done: the reply, the files, and a live preview if the model made a web page (a locked frame, section 6). OPEN BIG, FILES, LOG. Under each card: 1 to 5 stars and a note. A table view shows the same results as rows: model, app, stars, time, tokens, cost. **+ MODELS** (top right) runs the exact same prompt on more models inside the same test, with the test's own effort and time limit. It opens the same model picker as NEW TEST, without the models already in the test (a model that is already in is refused), and RUN. The new results join the same cards, the ranking and the table, and come last; a blind test that has not been revealed gives them the next letters (MODEL D, E, ...), so REVEAL waits until they have stars too. One test holds 12 models at most. It works on an archived test too (it stays in the archive).

   **FOLLOW UP** (2026-10-26; the owner: a model finished in one minute with a page that did not follow the prompt, so talk to it again instead of starting over): every finished result (DONE, TIME UP, PLAN LIMIT, FAILED, STOPPED) has FOLLOW UP. It opens a small chat for that result, beside the cards on a wide screen and the whole screen on a phone: the prompt (folded), the model's reply, then each follow-up and its reply, and at the bottom a text box with DICTATE and SEND (Ctrl+Enter). SEND runs the same model, app and effort with the test's time limit, in the same files folder, through the normal queue (a local model still runs alone). While it works the chat and the card say WORKING; when it ends the reply shows and the card's page loads again. A second follow-up waits until the first is done.

   The app's own session cannot go on: it lived in the box's HOME, which is deleted after every run, and keeping it would keep sign-in material on disk. So the prompt carries the context (`followUpPrompt` in `server/labfollow.ts`): a note that its earlier work is in this folder and should be changed, not made again; the original prompt; the earlier follow-ups (they still hold); the first 1,500 characters of its last reply, or how its last run ended (time limit, plan limit, stopped, failed); and the new follow-up last. The exact prompt is kept in the result folder as prompt.md, and LOG shows it. A real session resume is a later option (section 8).

   **Versions**: before a follow-up and before RUN AGAIN, the result as it is is kept in `versions/<n>/` inside its folder: its result.json (with its stars), reply.md, log.jsonl and files/. A follow-up copies files/ with `cp -a --reflink=always`: on btrfs and XFS the copy shares the data with the original, so even node_modules costs nothing. Where reflinks are not supported (ext4) it copies everything but the junk folders (node_modules and the like, as REMOVE JUNK). RUN AGAIN moves files/ into the version and starts in an empty folder. When the lab built the page (after the run, or BUILD THE PAGE), a follow-up deletes that build (dist/, build/ or out/) from files/ once the version holds it, so the old page cannot show for the new source; the lab builds it again after the run. The chat has VIEW on each reply: that version's page in the same locked viewer, at `/lab/v/<key>/<test>/<result>@<n>/` (or its reply when it made no page). Versions from before a RUN AGAIN are listed at the top as earlier runs.

   **Fair play**: a result with follow-ups has a +1 FOLLOW-UP badge (cards, table, ranking, OPEN BIG and the HISTORY results). A follow-up clears its stars and rank: its output changed, so the owner rates it again (the version keeps the old stars), and the results below it in the ranking move up one place. A blind test stays blind: the chat says MODEL B, and the prompt names no model. TIME, TOKENS and COST on the card are the last run's; the chat shows each turn's.

   **RUN AGAIN** works on every finished result (2026-10-26; before, only on failed, stopped and limited ones). On a DONE result it asks first: "This replaces its result; the old one is kept as a version." Its stars, rank, note and follow-ups are cleared.
3. **HISTORY**: the big table of every test ever, newest first. Search the prompt text. Filter by date, model, app, stars. Charts: average stars per model, stars against cost, time per model. A row opens its test.
4. **ARCHIVE**: archived tests, kept but hidden from HISTORY unless you ask. On any test: ARCHIVE, DELETE (it shows the size first), and REMOVE JUNK (deletes `node_modules` and build caches, keeps the reply, the files, the log and the stars).

**Video mode** (a switch on a test): full screen 16:9, big text, race timers. Blind: cards show A, B, C, D until all have stars; REVEAL shows the names. Recording-safe: hides paths, account names and emails, and (optional) costs.

Live updates use the existing WebSocket store patches, like the crew cards.

## 6. Showing a result safely

A page a model made is unknown code. It must not reach the Phosphor API, which can run commands.

- Pages are served from `/lab/v/<random key per test>/<result>/...` with the header `Content-Security-Policy: sandbox allow-scripts allow-pointer-lock`. The page then has no origin: it cannot read cookies or call the API with the login. The login cookie is `SameSite=Lax`; check in phase 1 that a sandboxed page's requests do not carry it.
- The key in the path lets the page load its own files without the login cookie. A key gives read-only access to one test only.
- The iframe also has `sandbox="allow-scripts"`.
- A kept version (section 5) is served the same way at `/lab/v/<key>/<test>/<result>@<n>/`, from `versions/<n>/files/` only.
- No `allow-modals` (2026-10-26): a broken page called `alert()` on every brush stroke and the box covered the whole app. The viewer's script turns `alert`, `confirm` and `prompt` into a short note inside the page (confirm says yes, prompt gives its default).
- Results that need a server (`npm run dev`) start on demand on a local port, in the same box, and stop when the card closes (phase 2).

## 7. Code map (new files)

| File | Does |
|---|---|
| `server/lab.ts` | tests and results on disk; `/api/lab/*` (`GET prompts` is the library, `POST tests/<id>/models` is + MODELS); the `/lab/v/` file server; `runner` (the model list and the queue, which tests swap for fakes) |
| `server/labrun.ts` | starts one result: makes the box, starts the app, reads its JSON stream, writes `result.json` and `reply.md`, stops it at the time limit |
| `server/labapps.ts` | one small adapter for each app: its model list, its command line, and how to read the reply, tokens, cost and the end from its JSON |
| `shared/lab.ts` | types for test and result (wire format); `promptLibrary` (the distinct-prompt list) |
| `web/src/lab.ts`, `web/src/lab.css` | the LAB screens; `web/src/labdemo.ts` is their data in demo mode (`/?demo=1`) |
| `scripts/lab-box.sh` | the bubblewrap command, so it can be tested alone |
| `tests/lab.ts` | adapters on saved JSON samples, reading old schema files, the box hides HOME |
| `server/labfollow.ts` | FOLLOW UP and versions: the follow-up prompt, keeping a version (`versions/<n>/`, reflink copy or a copy without junk), the version list for the chat |
| `tests/lab-queue.ts`, `tests/lab-library.ts`, `tests/lab-followup.ts` | the queue rules and effort levels; the prompt list and + MODELS (duplicates refused, blind letters, test.json kept); FOLLOW UP and RUN AGAIN (the prompt, versions, stars and rank cleared, queue order, refused while running, blind kept, the version viewer). All with a fake model list and queue, no model started |

## 8. Steps

| Phase | What | Effort |
|---|---|---|
| 0 | Proof from a script: one prompt through each app, in the box. Check: the JSON gives the reply, tokens and the end; the clean room works (no memory, no skills); the box hides HOME. Sign-ins: `codex login`, the OpenCode Go key, `claude setup-token`. | S |
| 1 | Runner, folders, NEW TEST, TEST with cards, stars and notes. | M |
| 2 | HISTORY table, search and charts; ARCHIVE, DELETE, REMOVE JUNK; previews that need a server. | M |
| 3 | Video mode: blind reveal, race timers, recording-safe. | S |
| 4 | Later: OpenRouter models, "same app" tests, a nightly backup copy of `data/lab/` without junk, a true session resume for FOLLOW UP (keep each app's session without its sign-in, or use the app's own resume, so the model remembers more than the prompt can carry). Done 2026-10-26: re-run a test on new models (the prompt LIBRARY and + MODELS, section 5); FOLLOW UP with versions. | S each |

Effort: S is 1 to 2 days, M is 3 to 5 days (helper time, untested estimates).

## 9. Risks

- `data/lab/` is on this PC's disk only. Until the backup copy exists (phase 4), a dead disk loses the history.
- App JSON formats change between versions. Adapters stay small and are tested against saved samples; `result.json` records the app version.
- Plan limits: ChatGPT Free has small Codex limits, and OpenCode Go has caps per 5 hours and per week. A result that hits a limit ends as LIMIT, not as a crash.
- Many apps at once use a lot of memory. Each result has its own memory-limited scope (section 3).
- A server restart stops running tests. On start, unfinished results are marked STOPPED, and RE-RUN starts them again.
- Terms: each plan is used only in its maker's own app. No plan sign-in moves into another app.
- + MODELS on a blind test: the new results take the next letters, so a model added alone is known by its letter (you just picked it).
- Versions: the ON DISK size in ARCHIVE counts each version in full (`du` cannot see that reflinked copies share their data), so it shows more than the disk really uses. REMOVE JUNK clears the versions' node_modules too.
- A follow-up's prompt holds the original prompt in full. agy and opencode get the prompt as one command-line argument, which Linux caps at 128 KB, so a very long prompt plus follow-ups can fail to start in those two apps.
