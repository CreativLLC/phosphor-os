# Model Lab: plan

Status: plan only, no code yet. Written 2026-10-23.

Goal: give one prompt to many AI models at the same time, keep every result, rate the results, and compare them in a big table and charts. It is made for recording videos: a clear side-by-side view, blind scores, and a reveal.

## 1. Words

- **Test**: one prompt with a score guide, stored as a file. It has a version. A changed prompt is a new version, so old scores stay fair.
- **Contestant**: one app + one model + one account. Example: "Kimi K3.1 Pro · opencode · OpenCode Go".
- **Battle**: one test given to 2 to 8 contestants at the same time.
- **Run**: one contestant's try in one battle. Each run has its own folder.

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

Why home apps and not one shared app:

- The Claude, ChatGPT and Google plans work only in their own apps. One shared app would mean pay-per-use for those models.
- The question a video answers is "which AI should I use?", and people use the home app.
- The app is a column in every table and on every card, so a viewer always sees it.

Later, "same app" battles: opencode can drive every OpenCode Go and OpenRouter model, and `agy` drives Gemini and Claude on one plan. Then only the model changes.

Notes:

- Gemini CLI's Google sign-in stopped working for personal accounts in June 2026. Use `agy`.
- OpenCode Go endpoints (its docs): Kimi, GLM and DeepSeek are on the OpenAI format only. The Anthropic format has only Qwen, MiniMax M3 and Claude Haiku. So "Claude Code + Kimi through Go" needs a translator. Not planned.
- OpenCode Go terms: it is for coding agents. Direct API calls must send their own user agent and an `x-opencode-session` header. Using the opencode app avoids this.

## 3. The clean room (fair and safe)

Every run:

- starts in a new empty folder, or a copy of the test's seed folder;
- runs inside bubblewrap (`bwrap`, installed): a box where HOME is a fake empty folder. The app sees only its run folder, its own sign-in file and the programs it needs. It cannot see SSH keys, cloud logins, synced folders or other projects;
- runs in its own systemd scope with a memory limit (`systemd-run --user --scope -p MemoryMax=...`), so a big build cannot take the server down with it;
- gets no skills, no memory, no MCP servers, no CLAUDE.md or AGENTS.md: each app starts with a fresh config folder that holds only its sign-in;
- has a time limit (default 10 min for a page, 30 min for a build). The runner stops it by PID after that;
- has network access, because the app must reach its model.

Sign-in for each app (check all of this in phase 0):

| App | Fresh config | Sign-in |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` in the box | a long-lived token from `claude setup-token`, in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. Never copy the main credentials file: a token refresh in the box could sign out the main app. |
| codex | `CODEX_HOME` in the box | the real `~/.codex/auth.json` bound read-write into it, so a refresh writes back to the one file |
| agy | fake HOME | its sign-in files bound in (find which files in phase 0) |
| opencode | `XDG_CONFIG_HOME` and `XDG_DATA_HOME` in the box | the real `auth.json` bound in |

Why the box matters: Codex, agy and opencode do not have Claude Code's hooks. In auto-approve mode a model can run any command.

## 4. What is saved

On the Linux disk, gitignored, in `data/lab/`. Not in a synced folder: build tests make big junk folders (`node_modules`), and syncing those is slow.

```
data/lab/
  tests/<test-id>.md          own tests (starter tests ship in lab/tests/)
  battles/<battle-id>/
    battle.json               test id + version, contestants, stars, notes, blind, archived
    <run-id>/
      run.json                app + app version, model, account, start, end, state, tokens, cost, exit code
      log.jsonl               the app's raw JSON stream (proof for the video)
      out/                    the run folder: what the model made
```

- To delete a battle, delete its folder. No database: the server builds the table by reading the `battle.json` and `run.json` files. That is fine for hundreds of battles. Add an index file only if it gets slow.
- Cost comes from the token counts in each app's JSON. Plan runs show "plan" and $0; pay-per-use runs show dollars.

## 5. Test files

```markdown
---
id: arcade-game
title: Retro arcade game
kind: page        # page | build | text
version: 1
time_limit: 10m
seed: none        # or a folder in lab/seeds/
check: none       # build: a command whose result is an auto score; text: the one right answer
---
The prompt, exactly as every model gets it.

## Score guide
- It opens in a browser with no errors.
- ...
```

Kinds:

- **page**: the model makes one `index.html`. The lab shows it live. Best for videos: fast, cheap, visual and fair.
- **build**: a project with many files. A `check` command (for example the tests) gives an auto score.
- **text**: the answer is text (a story, a puzzle answer). Where there is one right answer, `check` scores it.

Starter set, version 1 (8 tests): retro arcade game (page), landing page for a made-up product (page), SVG drawing of a strange thing (page), balls in a spinning hexagon (page), to-do app with tests (build), fix 3 bugs in a seed repo (build, auto score), children's story in a set style (text), logic puzzle with one answer (text, auto score).

## 6. Screens

A new program, **LAB**: next to DOCS on the program bar, and in the launcher on the phone.

1. **TESTS**: one card for each test. RUN on a card opens NEW BATTLE.
2. **NEW BATTLE**: tick the contestants, set blind on or off, set the time limit. START runs them all at once (local models one at a time).
3. **ARENA**: one card for each contestant, in a grid (2, 3, 4 or 2x4). While it runs: state, timer, tokens. When done: the result (a live page in a locked frame, or the text), OPEN BIG, FILES, LOG. Under each card: 1 to 5 stars and a note. Blind: cards show A, B, C, D until all have stars; REVEAL shows the names.
4. **BOARD**: the big table, one row for each run: test, model, app, account, stars, auto score, time, tokens, cost, date. Sort and filter. Charts on top: average stars per model, stars against cost, time per model. A row opens its arena.
5. **ARCHIVE**: archived battles are kept but hidden from BOARD. CLEAN UP deletes battles (it shows the size first), or removes junk only (`node_modules`, build caches) and keeps the result, the log and the scores.

**Video mode** (a switch in ARENA): full screen 16:9, big text, a "versus" title card, race timers and the reveal. Recording-safe: hides paths, account names and emails, and (optional) costs.

Live updates use the existing WebSocket store patches, like the crew cards.

## 7. Showing a result safely

A page a model made is unknown code. It must not reach the Phosphor API, which can run commands.

- Pages are served from `/lab/v/<random key per battle>/<run-id>/...` with the header `Content-Security-Policy: sandbox allow-scripts allow-pointer-lock`. The page then has no origin: it cannot read cookies or call the API with the login. The login cookie is `SameSite=Lax`; check in phase 1 that a sandboxed page's requests do not carry it.
- The key in the path lets the page load its own files without the login cookie. A key gives read-only access to one battle only.
- The iframe also has `sandbox="allow-scripts"`.
- Build results that need a server (`npm run dev`) start on demand on a local port, in the same box, and stop when the card closes (phase 2).

## 8. Code map (new files)

| File | Does |
|---|---|
| `server/lab.ts` | tests, battles and runs on disk; `/api/lab/*`; the `/lab/v/` file server |
| `server/labrun.ts` | starts one run: makes the box, starts the app, reads its JSON stream, writes `run.json`, stops it at the time limit |
| `server/labapps.ts` | one small adapter for each app: the command line, and how to read tokens, cost and the end from its JSON |
| `shared/lab.ts` | types for test, battle and run (wire format) |
| `web/src/lab.ts`, `web/src/lab.css` | the LAB screens |
| `lab/tests/*.md`, `lab/seeds/` | starter tests and seed folders |
| `scripts/lab-box.sh` | the bubblewrap command, so it can be tested alone |
| `tests/lab.ts` | test file parsing, adapters on saved JSON samples, the box hides HOME |

## 9. Steps

| Phase | What | Effort |
|---|---|---|
| 0 | Proof from a script: one "make index.html" prompt through each app, in the box. Check: the JSON gives tokens and the end; the clean room works (no memory, no skills); the box hides HOME. Sign-ins: `codex login`, the OpenCode Go key, `claude setup-token`. | S |
| 1 | Runner, storage, TESTS, NEW BATTLE, ARENA with stars. Page kind only. The 4 page tests. | M |
| 2 | BOARD table and charts, ARCHIVE, CLEAN UP, build and text kinds, auto scores. | M |
| 3 | Video mode: blind reveal, versus card, race timers, recording-safe. | S |
| 4 | Later: OpenRouter contestants, "same app" battles, an AI judge (a model scores against the score guide, shown apart from your stars), re-run a battle. | S each |

Effort: S is 1 to 2 days, M is 3 to 5 days (helper time, untested estimates).

## 10. Risks

- App JSON formats change between versions. Adapters stay small and are tested against saved samples; `run.json` records the app version.
- Plan limits: ChatGPT Free has small Codex limits, and OpenCode Go has caps per 5 hours and per week. A run that hits a limit ends as LIMIT, not as a crash.
- 4 to 8 apps at once use a lot of memory. Each run has its own memory-limited scope (section 3).
- A server restart stops running battles. On start, unfinished runs are marked STOPPED, and RE-RUN starts them again.
- Terms: each plan is used only in its maker's own app. No plan sign-in moves into another app.
