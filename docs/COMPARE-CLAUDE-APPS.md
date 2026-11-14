# Phosphor-OS vs the Claude Code desktop app and CLI (2026-11-14)

A comparison at one point in time. Sources: the Phosphor-OS code and docs; Anthropic's docs (https://code.claude.com/docs/en/desktop, /claude-code-on-the-web, /commands, /hooks, /whats-new) and the anthropic-claude-code GitHub releases; `claude --help` on this PC. Items marked "(unconfirmed)" were not found in a source. Versions: the CLI on this PC is 2.1.314 (newest 2.1.325, 2026-11-13); the Agent SDK in Phosphor-OS is 0.3.325.

## What Phosphor-OS does better

| Area | Phosphor-OS | Claude desktop app / CLI |
|---|---|---|
| Linux | Made for it: the whole desktop (Omarchy pack: bar, clock, notifications, screensaver, keys) | Desktop app is Mac and Windows; Linux beta on Ubuntu/Debian, Code tab there unconfirmed |
| Save Claude usage | ROUTER hands big reads to a local model (`ask_local`) and shows the tokens kept off Claude; AUTO picks model and effort per message; local Qwen/Gemma in the same picker; BIG CHAT bar; prompt cache warm/cold clock | `/usage`, `/context`, compaction; no local models |
| Many models | Gemini chats (agy), Model LAB: one prompt on Claude, Codex, opencode, agy and local models in a sandbox, blind ranking | Claude models only |
| Phone | The full app over Tailscale as a home-screen app, passkey/fingerprint login, push alerts | Remote Control and the Code tab in the Claude mobile app (cloud relay) |
| Voice | On-PC speech engine: DICTATE, Ctrl+Space in any app, CLEAN UP, PROMPTER punch list | `/voice` in the CLI (unconfirmed details) |
| Projects | Lead chat plus thread chats, shared memory file, project panel | Projects that steer cloud sessions (web) |
| Seeing the work | Mission panel and progress bar, helper crew scenes, per-helper rows | Tasks pane, subagent pane |
| Life around the work | DOCS editor, TODAY calendar, STATION homelab, IDEAS inbox, YouTube tools | None |

## What the desktop app or CLI has and Phosphor-OS does not

| Gap | Where it exists | Note |
|---|---|---|
| Diff review pane with per-line comments, "Apply fixes" | Desktop, web | Phosphor-OS shows +/- lines inside the chat only |
| Git and PR actions: create PR, CI status, auto-fix failing checks, merge when ready | Desktop, web, `/autofix-pr` | None in Phosphor-OS |
| Git worktree per session (parallel work without clashes) | Desktop, `--worktree` | None |
| Idle compaction: a chat over 200K compacts while you are away, so the next message is cheap | Desktop and VS Code (v2.1.314); env `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, `CLAUDE_CODE_IDLE_THRESHOLD_MINUTES` exist in the CLI | Phosphor-OS has the BIG CHAT bar only. How the env vars work: unconfirmed |
| Stop one helper; background tasks list | `/tasks`, SDK `stopTask`, `backgroundTasks` | Phosphor-OS shows helpers but can only stop the whole chat |
| Side chat: ask about the session without adding to it | Desktop (Ctrl+;), `/btw` | None |
| Suggested next prompt (Tab accepts) | Desktop; SDK `promptSuggestions` | None |
| Context breakdown (what fills the window) | `/context`; SDK `getContextUsage` | Phosphor-OS shows one number |
| Dev-server preview with `.claude/launch.json`, auto verify | Desktop | Phosphor-OS has a browser pane, no launch config |
| Terminal pane inside the app | Desktop (Ctrl+`) | Phosphor-OS RUN opens an outside terminal |
| Session rename, archive, filter, split view, Ctrl+Tab | Desktop | Phosphor-OS: tabs and HISTORY |
| Scheduled tasks (cron, GitHub events) | Cloud, `/schedule`, `/loop` | Only the IDEAS weekly digest |
| Cloud sessions that keep running with the PC off | Web, `--cloud`, `--teleport` | Phosphor-OS runs on this PC only |
| Computer use | Desktop on Mac and Windows | Not on Linux |
| Code review (`/code-review`, `/ultrareview`, `/security-review`) | CLI, desktop | Works as slash commands in a Phosphor-OS chat; no review card |
| Fallback model, dollar cap per run | SDK `fallbackModel`, `maxBudgetUsd` | Not used |
| Hooks UI, plugin and skill browser | Desktop Customize sidebar, `/hooks`, `/plugin` | MCP panel only |

## Top 5 to build

1. **Idle compaction.** A chat over ~150K that sits idle until its prompt cache goes cold gets compacted before the next message, so that message re-reads a summary, not the whole chat. Biggest usage win for the least work: the CLI may already do it through env vars (test first).
2. **Stop one helper + a tasks list.** A STOP on each helper row and a list of running background jobs (`stopTask`, `backgroundTasks`). Helpers that go wrong now cost a whole chat stop or the usage they burn.
3. **Diff review pane.** All files a chat changed, side by side, with comments on lines sent back to Claude in one message, and a COMMIT button. The main gap for code work like the game.
4. **Worktree per chat.** A toggle on a new chat: it works in its own git worktree, so two chats can build two game features at once without clashing.
5. **Side chat.** Ask a quick question about the chat (Ctrl+;) in a throwaway side session, so the main chat's context does not grow.

Cheap extras: suggested next prompt (one SDK option), context breakdown in the CTX gauge (`getContextUsage`), update the CLI to 2.1.325.
