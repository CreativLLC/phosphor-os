# Hermes chat

Chat with [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT) inside Phosphor-OS, on the local models of your llama.cpp router. Hermes can use a real browser (fill in forms, read pages), run commands and change files. In a new chat, pick a **Hermes ·** model in the picker, then chat as usual.

Checked with Hermes Agent 0.23.2 (2026-11-17).

## Set up

1. Have the local models working first (docs/LOCAL-MODEL.md). Hermes needs a context of at least 64K tokens.
2. Install Hermes. Read its installer first, then run it without the setup wizard (the wizard offers to import other agents' settings, `~/.claude` included):
   ```bash
   curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh
   bash /tmp/hermes-install.sh --skip-setup --skip-computer-use
   ```
3. Point Hermes at the router in `~/.hermes/config.yaml`. The key is read from the router's key file, never copied:
   ```yaml
   providers:
     llamacpp:
       base_url: "http://127.0.0.1:8081/v1"
       key_cmd: "cat <path to your local-model.key>"
       model: "<first model name in local-models.ini>"
   model:
     default: "<the same model name>"
     provider: "custom"
     base_url: "http://127.0.0.1:8081/v1"
     context_length: <ctx-size from local-models.ini>
   ```
   Without `context_length` Hermes guesses the model's full size (256K for Gemma 4), more than the router serves.
4. Make risky commands always ask (Hermes's default lets a helper model approve them): `hermes config set approvals.mode manual`
5. Install the guards (below): `node scripts/hermes-guards.mjs install`
6. Restart the server. The picker lists one **Hermes ·** entry per router model (models on their own server, such as Strata, are left out: Hermes's config points at the router only).

Check: `hermes -z "Use the terminal tool to run: date"` answers with the real date.

## The guards (required)

Hermes can run commands in every mode, so a Hermes chat starts only when the guards are in place; otherwise the chat says how to install them. `scripts/hermes-guards.mjs` is a Hermes `pre_tool_call` shell hook (in `~/.hermes/config.yaml` between `phosphor-guards` markers, plus Hermes's hook allowlist), run before every tool call, with `fail_closed: true`:

- **Claude Code's PreToolUse hooks** (managed, user, project settings), with the mapping `agy-guards.mjs` uses for Gemini: `terminal` and `execute_code` are Bash, `write_file` / `patch` / `read_file` keep Claude's file tools, every other tool (browser, web, helpers, connectors) is checked as Bash and as a web address with all its text. A block from any hook blocks the tool.
- **The chat's mode**, from `data/hermes-modes.json` (the app writes it per Hermes session): PLAN ONLY blocks every tool that changes something; ASK FIRST sends each one to the chat as an OK card.
- **Hands off the guards:** commands, code and file writes that name Hermes's settings, its hook allowlist, Claude Code's settings or hooks, or the guard files are blocked.

The hook is global: it guards Hermes in a terminal and on its messaging gateway too (there with Claude Code's hooks only, no mode). Remove: `node scripts/hermes-guards.mjs remove` (Hermes chats then refuse to start). Status: `node scripts/hermes-guards.mjs status`.

## Modes

| Mode | Hermes |
|---|---|
| ASK FIRST | An OK card before each command, code run, file change or browser step (reading and web search go through) |
| PLAN ONLY | Tools that change things are blocked; the message tells Hermes to reply with a plan |
| AUTO-EDIT, AUTO | File changes go through; commands Hermes flags as risky still ask |
| BYPASS | Every OK is answered yes by the app |

Claude Code's hooks apply in every mode.

## How it works

- `server/hermestab.ts`: one `hermes acp` process per open Hermes chat (started at the first message, again after it ends), speaking the Agent Client Protocol over stdin/stdout. A session per chat (`session/new`, `session/load` after a restart); before each message the app sets the edit policy (`session/set_config_option`) and the model (`session/set_model`, `custom:<name>`), takes the GPU's chat turn (the image model waits), then sends `session/prompt`.
- Updates become chat items: `agent_message_chunk` streams the reply, `tool_call` / `tool_call_update` are tool lines with their output, a completed edit counts as a changed file. `session/request_permission` shows the same OK card as Claude's (BYPASS answers it). STOP sends `session/cancel` and withdraws open cards.
- Saved: `data/hermes-chats/<session>.json` (the chat as shown); tabs.json keeps `hermes: <session>`; HISTORY lists them as `hermes:<session>` with HERMES on the row. Hermes keeps its own copy in `~/.hermes/state.db`.
- The page hides what only Claude has (UNDO, the "/" list, CONTEXT, the task list), as for Gemini.
- Test: `npx tsx tests/hermeschat.ts` (a fake `hermes acp`, `tests/fixtures/hermes/`).

## Traps

- A vague request can make a small local model invent a tool's output instead of calling the tool. Name the tool: "use the browser to…", "use the terminal to run…".
- Hermes and Claude's local-model chats share the router, which holds one model at a time: a Hermes chat on another model swaps it out.
- Hermes's own setup wizard (`hermes setup`) offers to import `~/.claude`; skip that step.
