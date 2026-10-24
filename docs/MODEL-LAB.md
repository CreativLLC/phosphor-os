# Model Lab: plan

Status: plan only, no code yet. Written 2026-10-23, changed the same day: the owner writes every prompt; the lab has no built-in tests.

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
- OpenCode Go endpoints (its docs): Kimi, GLM and DeepSeek are on the OpenAI format only. The Anthropic format has only Qwen, MiniMax M3 and Claude Haiku. So "Claude Code + Kimi through Go" needs a translator. Not planned.
- OpenCode Go terms: it is for coding agents. Direct API calls must send their own user agent and an `x-opencode-session` header. Using the opencode app avoids this.

## 3. The clean room (fair and safe)

Every result:

- starts in a new empty folder;
- runs inside bubblewrap (`bwrap`, installed): a box where HOME is a fake empty folder. The app sees only its result folder, its own sign-in file and the programs it needs. It cannot see SSH keys, cloud logins, synced folders or other projects;
- runs in its own systemd scope with a memory limit (`systemd-run --user --scope -p MemoryMax=...`), so a big build cannot take the server down with it;
- gets no skills, no memory, no MCP servers, no CLAUDE.md or AGENTS.md: each app starts with a fresh config folder that holds only its sign-in;
- has a time limit (set per test, default 30 min). The runner stops it by PID after that;
- has network access, because the app must reach its model.

Sign-in for each app (check all of this in phase 0):

| App | Fresh config | Sign-in |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` in the box | a long-lived token from `claude setup-token`, in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. Never copy the main credentials file: a token refresh in the box could sign out the main app. |
| codex | `CODEX_HOME` in the box | the real `~/.codex/auth.json` bound read-write into it, so a refresh writes back to the one file |
| agy | fake HOME | its sign-in files bound in (find which files in phase 0) |
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
        gpt-6--codex/
          ...
  archive/                                 same layout; ARCHIVE moves a test folder here
```

Rules that keep it readable a year from now:

- Everything is plain files: Markdown and JSON. A test folder still makes sense with no lab and no Phosphor-OS.
- Each `result.json` keeps the exact model id, the app version and the date, so it is always clear which model ran (names like "latest" change over time).
- Each JSON file has a `schema` number. A newer lab reads old files; it never rewrites them in a new shape.
- The folder is the truth. Moving a test folder into `archive/` by hand is the same as the ARCHIVE button. Deleting it by hand is the same as DELETE. The lab reads the folders again when it opens.
- Stars and notes live in `result.json`, inside the result folder, so they move with it.
- Cost comes from the token counts in each app's JSON. Plan results show "plan" and $0; pay-per-use results show dollars.

## 5. Screens

A new program, **LAB**: next to DOCS on the program bar, and in the launcher on the phone.

1. **NEW TEST**: a big prompt box, an optional title, the model list with ticks (it remembers your last picks), a time limit, and START. All ticked models start at the same time (local models one at a time).
2. **TEST**: one card for each model, side by side. While it runs: state, timer, tokens. When done: the reply, the files, and a live preview if the model made a web page (a locked frame, section 6). OPEN BIG, FILES, LOG. Under each card: 1 to 5 stars and a note. A table view shows the same results as rows: model, app, stars, time, tokens, cost.
3. **HISTORY**: the big table of every test ever, newest first. Search the prompt text. Filter by date, model, app, stars. Charts: average stars per model, stars against cost, time per model. A row opens its test.
4. **ARCHIVE**: archived tests, kept but hidden from HISTORY unless you ask. On any test: ARCHIVE, DELETE (it shows the size first), and REMOVE JUNK (deletes `node_modules` and build caches, keeps the reply, the files, the log and the stars).

**Video mode** (a switch on a test): full screen 16:9, big text, race timers. Blind: cards show A, B, C, D until all have stars; REVEAL shows the names. Recording-safe: hides paths, account names and emails, and (optional) costs.

Live updates use the existing WebSocket store patches, like the crew cards.

## 6. Showing a result safely

A page a model made is unknown code. It must not reach the Phosphor API, which can run commands.

- Pages are served from `/lab/v/<random key per test>/<result>/...` with the header `Content-Security-Policy: sandbox allow-scripts allow-pointer-lock`. The page then has no origin: it cannot read cookies or call the API with the login. The login cookie is `SameSite=Lax`; check in phase 1 that a sandboxed page's requests do not carry it.
- The key in the path lets the page load its own files without the login cookie. A key gives read-only access to one test only.
- The iframe also has `sandbox="allow-scripts"`.
- Results that need a server (`npm run dev`) start on demand on a local port, in the same box, and stop when the card closes (phase 2).

## 7. Code map (new files)

| File | Does |
|---|---|
| `server/lab.ts` | tests and results on disk; `/api/lab/*`; the `/lab/v/` file server |
| `server/labrun.ts` | starts one result: makes the box, starts the app, reads its JSON stream, writes `result.json` and `reply.md`, stops it at the time limit |
| `server/labapps.ts` | one small adapter for each app: its model list, its command line, and how to read the reply, tokens, cost and the end from its JSON |
| `shared/lab.ts` | types for test and result (wire format) |
| `web/src/lab.ts`, `web/src/lab.css` | the LAB screens |
| `scripts/lab-box.sh` | the bubblewrap command, so it can be tested alone |
| `tests/lab.ts` | adapters on saved JSON samples, reading old schema files, the box hides HOME |

## 8. Steps

| Phase | What | Effort |
|---|---|---|
| 0 | Proof from a script: one prompt through each app, in the box. Check: the JSON gives the reply, tokens and the end; the clean room works (no memory, no skills); the box hides HOME. Sign-ins: `codex login`, the OpenCode Go key, `claude setup-token`. | S |
| 1 | Runner, folders, NEW TEST, TEST with cards, stars and notes. | M |
| 2 | HISTORY table, search and charts; ARCHIVE, DELETE, REMOVE JUNK; previews that need a server. | M |
| 3 | Video mode: blind reveal, race timers, recording-safe. | S |
| 4 | Later: OpenRouter models, "same app" tests, re-run a test on new models, a nightly backup copy of `data/lab/` without junk. | S each |

Effort: S is 1 to 2 days, M is 3 to 5 days (helper time, untested estimates).

## 9. Risks

- `data/lab/` is on this PC's disk only. Until the backup copy exists (phase 4), a dead disk loses the history.
- App JSON formats change between versions. Adapters stay small and are tested against saved samples; `result.json` records the app version.
- Plan limits: ChatGPT Free has small Codex limits, and OpenCode Go has caps per 5 hours and per week. A result that hits a limit ends as LIMIT, not as a crash.
- Many apps at once use a lot of memory. Each result has its own memory-limited scope (section 3).
- A server restart stops running tests. On start, unfinished results are marked STOPPED, and RE-RUN starts them again.
- Terms: each plan is used only in its maker's own app. No plan sign-in moves into another app.
