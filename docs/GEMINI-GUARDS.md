# Command guards for Gemini (agy) and the LAB agents

The first parts are about Gemini (agy). [LAB: Claude Code, Codex and opencode](#lab-claude-code-codex-and-opencode), at the end, is about the other agents in the Model Lab.

Gemini chats and LAB runs of Gemini go through Google's Antigravity CLI (`agy`). agy does not read Claude Code's settings, so Claude Code's PreToolUse hooks (for example a block on writes to a production org, or on reaching a server Claude must not touch) would not guard what Gemini does. These guards close that gap: agy runs every tool step past the same hooks first. Only with them in place do Gemini chats run commands in AUTO and BYPASS.

## How it works

- `scripts/agy-guards.mjs` is an agy PreToolUse hook for every tool (matcher `*`). It turns agy's tool call into the input Claude Code's hooks read (`tool_name`, `tool_input`, `cwd`, `hook_event_name: PreToolUse`), runs the PreToolUse hooks Claude Code would run (managed settings, `~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`, and the chat folder's `.claude/settings.json` and `settings.local.json`), and answers agy.
- agy's tools as Claude Code's: `run_command` (and `manage_task` input, `send_command_input`, `shell_exec`) are `Bash` with the command; `read_file`, `write_file`, `edit_file` are `Read`, `Write`, `Edit`; list and search tools and helper agents are not checked (a helper's own steps come through the guards too). Every other tool (web pages, browser tools, connectors, tools agy adds later) is checked as `Bash` and as `WebFetch` with all of its text, so a tool that can reach a server is not missed.
- A hook that exits 2, or prints Claude Code's JSON deny (`permissionDecision: "deny"` or `decision: "block"`), is a block: agy gets `{"decision":"deny","reason":...}` with the hook's own words, and the chat's tool line shows them.
- No block: the answer is `{"decision":"ask"}`, which leaves the decision to agy's mode (tested: "ask" runs nothing that the mode would refuse). Not `allow`, which would skip agy's own permission checks.
- It fails closed: a hook that fails, times out (its own `timeout`, else 30 s) or cannot start, unreadable settings, or bad input all answer deny. agy itself also blocks the tool when this script fails, times out or prints no JSON (tested).
- The guards guard themselves: commands and file writes that name agy's hooks file (`~/.gemini/config/`), a folder's `.agents/hooks.json`, Claude Code's settings or hooks folder, or this script are blocked, so a BYPASS run cannot switch them off first.

Like Claude Code's hooks, this is a seat belt, not a wall: a script file Gemini writes and then runs is checked by its command line only.

## Install, check, undo

agy reads hooks only from hooks files (`~/.gemini/config/hooks.json`, a folder's `.agents/hooks.json`, plugins), not from `--settings`, so the guards go in agy's shared hooks file as one named entry, `phosphor-guards`. Other entries in that file stay as they are.

```bash
node scripts/agy-guards.mjs install   # add the entry (again = the same)
node scripts/agy-guards.mjs status    # is it there
node scripts/agy-guards.mjs remove    # undo: take only our entry out
```

Run them in the Phosphor-OS folder. The entry runs this copy of the script with Node as found on PATH (a version manager's stable link, not one exact version). No server restart is needed: the app checks at the start of every AUTO or BYPASS run. The entry also applies to agy in a terminal: the same guards, every tool step.

## What the app does with them (`server/geminitab.ts`)

At the start of every AUTO or BYPASS run, `geminiGuards` checks that the entry is there, not switched off (`"enabled": false`), points at this copy of the script, and answers a test call (the command `true`) with at least one Claude Code PreToolUse hook for commands (`Bash`). Then:

| Mode | agy flags | Commands |
|---|---|---|
| ASK FIRST | default mode, chat folder read-only (bubblewrap) | none |
| PLAN ONLY | `--mode plan`, folder read-only | none |
| AUTO-EDIT | `--mode accept-edits` | none |
| AUTO, guards in place | `--mode accept-edits --sandbox --settings {"toolPermission":"proceed-in-sandbox"}` | inside agy's terminal sandbox, without asking: no network, writes only in the folder and temp folders; a command that must leave the sandbox is refused |
| BYPASS, guards in place | `--dangerously-skip-permissions` | anything, outside the sandbox; the guards still run on every step |
| AUTO or BYPASS, guards missing | `--mode accept-edits` | none; picking BYPASS says why and stays AUTO, and a refused command's note says why |

agy's own `--mode auto` (a reviewer agent for commands that leave the sandbox) said "unavailable (rollout flag off)" for this account on 2026-10-30 and then runs in the default mode, so AUTO uses the sandbox setting instead.

LAB (`server/labrun.ts`, `labGuards`): each Gemini run's box gets its own copy of the entry (pointing at the script, bound read-only at `/opt/phosphor/agy-guards.mjs`), a copy of only the PreToolUse part of Claude Code's settings, and the hook script files those name, all read-only. A hook that cannot run inside the box blocks every tool step of that run.

## Tested (agy 1.4.12, 2026-10-30)

- agy's hook contract, end to end with `agy -p` in a temp folder and a marker rule: `deny` blocks (also with `--dangerously-skip-permissions` and in a helper agent's steps); `""` and `{}` block too; `ask` defers to the mode (runs with BYPASS and in the sandbox, refused in AUTO-EDIT, file reads unaffected); a hook that exits non-zero, prints non-JSON or times out blocks.
- The guard script with agy-shaped input against the owner's real hooks (prod-write and media-server): a deploy to the production alias, a deploy without a target org, a delete through `manage_task` input, `curl`, `ssh` and `ping` to the server's addresses and name, and the server address in `read_url_content`, `execute_url` and `open_browser_url` were all denied with the hooks' own words; a sandbox deploy, a prod read query, `ssh` to the allowed VM alias and other sites passed. The owner's hook scripts with Claude Code-shaped input: unchanged (exit 2 and 0 as before).
- End to end through the installed entry (`agy -p`, Gemini 3.8 Flash): a marker rule in the folder's `.claude/settings.json` blocked `echo PHOSPHOR_GUARD_TEST` in BYPASS; the real hooks blocked `echo sf project deploy start` (BYPASS) and an `echo curl <server address>` (AUTO); harmless `echo` ran in AUTO's sandbox; AUTO-EDIT still wrote a file and still refused the command. Only `echo` was ever run, so a failed guard could not have reached an org or the server.
- LAB: one real run of Gemini 3.8 Flash in the box: the same two `echo` commands were blocked by the real hooks, `echo lab-ok` ran, the page was made.
- `tests/agy-guards.ts` (made-up hooks, temp folders) and `tests/geminichat.ts` (mode flags, the check, BYPASS offered or not, notes).

Untested: a real Gemini chat in the app (the server needs a restart for the new code); agy's own auto mode with the guards (not available to this account); Windows and macOS.

## LAB: Claude Code, Codex and opencode

Added 2026-11-02. Claude chats get the owner's hooks from Claude Code itself. LAB runs (`server/labrun.ts`) start each agent in a bubblewrap box with an empty config and the network, so none of the owner's hooks ran there (agy's did since 2026-10-30, above). Now every agent that can run commands in the box runs them.

- **Where the hooks come from**: `ownerHooks()` reads the PreToolUse hooks from `/etc/claude-code/managed-settings.json` and `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) at the start of every run, the way `scripts/agy-guards.mjs` does, so there is one place to change them. The box gets a read-only copy of only that part and the hook scripts those commands name. If the settings have no PreToolUse hooks (another user's PC) the run goes without guards and the server log says `[lab] <app>: Claude Code's settings have no PreToolUse hooks, so this run has no command guards.`
- **The bridge** (`scripts/hook-bridge.mjs`, bound at `/opt/phosphor/` next to `agy-guards.mjs`, which it imports): `node hook-bridge.mjs <settings file>`. It reads one hook input on stdin, runs the matching hooks with that same input (so they see the agent's own `tool_name`, `tool_input` and `cwd`), and answers with exit 0 and no output (no objection) or exit 2 and the reason on stderr (block). Claude Code and Codex both read exactly that. It blocks on: input that is not JSON or has no `tool_name`; a settings file that is missing or broken; a hook that exits with anything but 0 or 2 (a crash, a hook that cannot start); a hook that runs past its `timeout` (30 s when it names none); a hook that prints JSON that does not parse; a hook's JSON deny (also the old `decision: block`). Plain text on stdout with exit 0 is no decision, as in Claude Code. Why a bridge and not the hooks themselves: for Claude Code and Codex a hook that crashes or times out is no block, the tool just runs.
- **A bridge that cannot start blocks too**: the hook command is `node /opt/phosphor/hook-bridge.mjs /opt/phosphor/hooks.json || exit 2`, so a missing node or file ends in exit 2. Its `timeout` for the agent is the slowest hook's plus 30 s, so the agent never gives up first.
- **The guards guard themselves**: commands (and Codex's patches) that name the hook settings or hooks of Claude Code, Codex, opencode or agy, `/opt/phosphor`, or the guard scripts are blocked, and so are Write and Edit of those paths. Like the hooks, this is a seat belt: a script file the agent writes and then runs is checked by its command line only.

| Agent | Commands | How the guards are wired (`plan()` in `server/labrun.ts`) |
|---|---|---|
| Claude Code (`claude`, and `local` for models on this PC) | yes, `--dangerously-skip-permissions` | `--settings '{"hooks":{"PreToolUse":[<the bridge, matcher *>]}}' --setting-sources ""`. The empty source list is needed: tested 2026-11-02 (Claude Code 2.1.314), `disableAllHooks` in the folder's `.claude/settings.json` or in the box's `~/.claude/settings.json` turned the hooks off; with no sources the run reads neither. |
| Codex | yes, `--dangerously-bypass-approvals-and-sandbox` | `-c hooks.PreToolUse=[...]` (the bridge), `-c features.hooks=true`, `--ignore-user-config`, and `--dangerously-bypass-hook-trust`: Codex skips hooks it has not been told to trust, and these are the app's own. Its tool names are Claude Code's (`Bash`, `apply_patch`). |
| opencode | yes, `--auto` | a plugin (`scripts/opencode-guards.mjs`, shown as the folder `/opt/phosphor/opencode-guards/` with `index.mjs`: opencode wants a directory) named in `OPENCODE_CONFIG_CONTENT`, with `OPENCODE_DISABLE_PROJECT_CONFIG=1`. It hooks `tool.execute.before` (opencode 2.2.2), turns the tool (`shell`, `webfetch`, `write`, `edit`, `patch`; any other tool as a command and a web address with all its text; read-only tools are not checked) into a Claude Code call, runs the bridge, and throws to block. |
| agy | yes, `--dangerously-skip-permissions` | unchanged: agy's hooks entry, above. |

Not agents, so not guarded: the page build (`buildPage`, `npm run build` in a box) and FOLLOW UP, which only reads files.

### Tested (2026-11-02)

- `tests/hook-bridge.ts` (made-up hooks, temp folders; the owner's hooks are never run): a hook that blocks (exit 2, JSON deny, old JSON `decision: block`), passes, prints plain text, crashes (exit 1, uncaught exception), cannot start, runs past its timeout, prints broken JSON; bad input; missing, broken and empty settings; a bad matcher; the hook gets the agent's input unchanged; the tamper checks for commands, Write, Edit and Codex patches; `labBridge` (no hooks: no bridge and a log line; with hooks: the copy, the files, the timeout, the command as the agent runs it, a bridge that cannot start, no node); opencode's tool mapping and a plugin whose bridge is missing.
- `tests/agy-guards.ts` also checks that agy's runner blocks a hook that prints broken JSON (it was waved through before; the bridge uses the same runner).
- Real LAB runs through the same code as the app (`scripts/lab-guards-check.ts`, no server, its own temp lab folder; only `echo` was ever asked for): Claude Haiku 5.5, Codex GPT 5.6 Luna, opencode Beam Free and Gemini 3.8 Flash each had a prod-write `echo` blocked with the owner's hook's own words and a plain `echo` run.
- By hand with Claude Code 2.1.314 and a made-up hook: a project and a local `.claude/settings.json` with `disableAllHooks` turned off the hooks given by `--settings` (so did one in the user settings); `--setting-sources ""` kept them.

Untested: the media-server hook through a LAB run (the repo holds no addresses, and the hook blocks a real one in the session that builds this too; it is the same bridge that ran the prod-write hook, and agy-shaped input was checked against it above); a `local` model run; whether a model-written project config can turn the guards off in Codex or opencode (Codex runs with `--ignore-user-config` and the flags above, opencode with project config off; neither was attacked); tools those CLIs add later (opencode's unknown tools are checked as command plus address; Codex's hook tool names are Claude Code's).
