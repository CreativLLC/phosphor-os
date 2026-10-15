# Any agent: plan for an agent-neutral Phosphor-OS

Status: plan only, no code changed. Written 2026-10-12 on branch `night/any-agent`.
Goal: anyone can bring their own agent. A Claude plan, a ChatGPT plan (Codex), OpenRouter, or a local model.

## 1. What "agent" means here

An agent is not a chat model. It is a **runtime** that:

- works in a folder (the tab's `cwd`);
- reads and edits files, runs shell commands, searches;
- asks before risky steps (tool permissions, modes such as plan or bypass);
- keeps sessions on disk, so a chat can be resumed;
- talks to a model, which may be Claude, GPT, an OpenRouter model or a local one.

So "support OpenRouter" really means "run an agent runtime that can use OpenRouter". Phosphor-OS should never write
its own tool loop. That is the same rule as the original plan: "Do not rewrite Claude Code. Build a skin on top."

## 2. What the UI depends on today

Everything comes from the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.296) in three server files.

| UI feature | Where it comes from now | File |
|---|---|---|
| Streaming reply text | `stream_event` text deltas (`includePartialMessages`) | `server/tab.ts` `onMessage` |
| Tool lines, files changed | `assistant` `tool_use` blocks, `tool_result.is_error` | `tab.ts` `onToolUse` |
| Permission cards | `canUseTool` callback, resolved by `perm` client event | `tab.ts` `canUseTool` |
| Question cards | `canUseTool` for `AskUserQuestion`, answers in `updatedInput` | same |
| Crew cards (subagents) | `system` `task_started` / `task_progress` / `task_updated` / `task_notification`, `parent_tool_use_id` | `tab.ts` `onSystem` |
| Mission panel | in-process MCP tool `update_mission` + `TodoWrite`; a hook blocks subagent calls | `tab.ts` `missionServer` |
| Busy / idle | `result.user_message_uuids`, `session_state_changed` | `tab.ts` |
| Context gauge, COMPRESS | `usage` on assistant messages, `modelUsage.contextWindow`, `compact_boundary`, `/compact` text | `tab.ts` |
| Usage meter | `usage_EXPERIMENTAL_...` on a live or private query | `server/usage.ts` |
| AUTO-CONTINUE | `rate_limit_event` (reset time), `assistant.error === 'rate_limit'` | `tab.ts` `limitHit` |
| History, resume, titles | `listSessions`, `getSessionMessages`, `getSessionInfo`, `resume` option | `server/tabs.ts`, `tab.ts` |
| UNDO | `enableFileCheckpointing` + `rewindFiles` | `tab.ts` `undo` |
| Model and effort pickers | `supportedModels()`, `setModel`, `applyFlagSettings({effortLevel})`, `resolveSettings` | `tabs.ts`, `tab.ts` |
| Mode picker | `setPermissionMode`, fixed `MODES` list | `shared/protocol.ts` |
| "/" menu | `supportedCommands()`, `terminal_slash_commands` | `tab.ts` `commands` |
| MCP screen, boot check | `mcpServerStatus`, `reconnectMcpServer`, `toggleMcpServer` | `server/mcp.ts`, `bootcheck.ts` |
| Attachments | image blocks in the user message, plus upload paths | `tab.ts` `userContent` |
| Voice, push alerts, files, SYS, DOCS, STATION | not agent specific | (no change needed) |

Coupling is good news: only `tab.ts`, `tabs.ts`, `usage.ts`, `mcp.ts` and `bootcheck.ts` import the SDK.
`shared/protocol.ts` is already almost neutral. The only Claude names on the wire are the item kind `'claude'` and
the fixed `MODES` and `EFFORTS` lists.

## 3. Options

Checked on this PC (read-only, no login, no prompts): `codex-cli 0.162.1` (mise), `opencode 1.19.0`,
`gemini 0.63.0`. Not installed: goose, aider, ollama, llama.cpp.

### Summary

| Option | Gives | UI loses | Effort | Risk |
|---|---|---|---|---|
| (a) Claude Agent SDK (today) | Everything in section 2 | nothing | 0 | SDK churn; subscription terms (below) |
| (b) Codex app-server (native) | Codex with ChatGPT plan or API key; rich events, rate limits, plan, subagents | slash commands list, effort names differ | M-L | protocol marked experimental, changes per version |
| (b') Codex via `codex-acp` | Codex through the ACP layer | usage meter, AUTO-CONTINUE, UNDO, most crew detail | S (after d) | adapter lags Codex |
| (c) opencode via `opencode acp` | 75+ providers: OpenRouter, Ollama, llama.cpp, LM Studio, ChatGPT plan, Copilot | usage meter, AUTO-CONTINUE, UNDO, crew detail | S (after d) | quality depends on the model |
| (c) Goose, OpenHands, Gemini CLI via ACP | more choice, same adapter | as above | XS each | small |
| (c) Aider | none usable | no structured interface found | n/a | skip |
| (d) ACP client in the server | one adapter for 40+ agents | features beyond the spec | M | some parts marked unstable |
| (e) OpenRouter, local models | through (c) or Codex `--oss` | as the runtime that carries them | XS config | small local models fail at tool use |

Effort: XS under a day, S 1 to 2 days, M 3 to 5 days, L over a week (helper time, untested estimates).

### (a) Claude Agent SDK, as today

- Gives: the full UI. Nothing else in this list has file checkpoints (UNDO), the usage meter, or crew progress this detailed.
- Keep it as a native backend. Do **not** move Claude to ACP (`@agentclientprotocol/claude-agent-acp` 0.89.1 exists),
  because the UI would lose `rewindFiles`, the usage call, MCP status, task events and hooks.
- License: proprietary. The SDK is under Anthropic's Commercial Terms; the Claude Code binary must run unmodified.
- **Subscription terms (important):**
  - SDK docs: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login
    or rate limits for their products, including agents built on the Claude Agent SDK." [A1]
  - Legal page: OAuth is for "ordinary use of Claude Code and other native Anthropic applications". Developers "may
    not collect, store, or intermediate Claude.ai credentials". But it "does not ... prevent an end user from signing
    in to the unmodified Claude Code binary with their own Claude subscription". [A2]
  - Reading: a person using their own plan on their own PC is the "local development" case (Anthropic staff said they
    want to allow it; secondary report [A3]). Shipping Phosphor-OS to other people with "use your Claude plan" as a
    feature is **not clearly allowed. Unverified; ask Anthropic before publishing.** Safe path: Phosphor-OS never
    touches the login; each user signs in with `claude` itself, or sets an API key.

### (b) OpenAI Codex

Three ways to drive it:

| Interface | What it is | Fit |
|---|---|---|
| `codex exec --json` | one prompt per process, JSONL events out | weak: no permission prompts (approvals are a policy flag), one shot |
| `@openai/codex-sdk` 0.162.1 | TS wrapper that spawns the CLI and reads JSONL | weak: docs show no approval callback; thread resume yes |
| `codex app-server` | long-lived JSON-RPC 2.0 over stdio, what the VS Code extension uses | **best fit** |

What app-server offers (method names from `codex app-server generate-ts` on this PC, 743 type files):

| UI feature | Codex app-server |
|---|---|
| Streaming text | `item/agentMessage/delta`, `item/started`, `item/completed` |
| Tool lines | items `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch` |
| Permission cards | server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` |
| Question cards | `item/tool/requestUserInput` (questions with options, like AskUserQuestion) |
| Mission panel | `turn/plan/updated` (steps with status), no tool needed |
| Crew cards | items `collabAgentToolCall` (status inProgress/completed/failed/interrupted), `subAgentActivity` |
| Busy / stop / steer | `turn/started`, `turn/completed`, `turn/interrupt`, `turn/steer` |
| Context gauge | `thread/tokenUsage/updated` (`modelContextWindow`), `thread/compact/start` |
| Usage meter + AUTO-CONTINUE | `account/rateLimits/read` and `.../updated`: `usedPercent`, `resetsAt`, `rateLimitReachedType` |
| History, resume, title | `thread/list`, `thread/read`, `thread/resume`, `thread/name/set` |
| UNDO | `thread/revert { beforeTurnId }`; **unverified** whether it puts files back |
| Models, effort | `model/list` with `supportedReasoningEfforts`, `defaultReasoningEffort` |
| Modes | `approvalPolicy` (untrusted, on-request, never) + `sandbox` (read-only, workspace-write, danger-full-access) |
| MCP screen | `mcpServerStatus/list`, `config/mcpServer/reload` |
| Custom tool (mission) | `dynamicTools` on `thread/start`, experimental [O1] |

- ChatGPT plan: yes. Login mode `chatgpt` means "Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them
  automatically". `codex login` in a terminal is enough; Phosphor-OS never sees a token. [O1]
- Stability: "app-server command and WebSocket transport are experimental and aren't supported for production
  workloads." The schema is "specific to the version of Codex" that generated it. [O1] Use stdio only (WebSocket
  listeners off loopback accept unauthenticated connections by default).
- Local models: `codex --oss --local-provider ollama|lmstudio`, and custom providers in `~/.codex/config.toml`.
- License: Apache-2.0 (npm `@openai/codex-sdk`).
- **Subscription terms:** "App-server authentication has never been permitted for commercial or hosted services.
  Existing local or open-source apps that use app-server authentication can keep running, but OpenAI recommends
  migrating to Sign in with ChatGPT." [O1] The open-source track of Sign in with ChatGPT: "ChatGPT plan usage is
  available to all open-source partners and selected private clients", after requesting a client ID. [O2]
  Reading: fine for the owner's own PC; a free open-source release should apply for that client ID. Phosphor-OS is a
  private repo today. **Commercial use with ChatGPT plans: not allowed without a partner deal.**

### (c) Open agent runtimes

| Runtime | Programmatic interface | Providers | License | Notes |
|---|---|---|---|---|
| **opencode** 1.19.0 (installed) | `opencode acp` (stdio), `opencode serve` (HTTP + SSE, 127.0.0.1, optional basic auth), `@opencode-ai/sdk` | OpenRouter, Ollama, llama.cpp, LM Studio, ChatGPT Plus/Pro login, Copilot, API keys [P1] | MIT (npm) | Its own docs say Claude Pro/Max login is prohibited by Anthropic; removed in 1.3.0 [P1] |
| **Goose** | ACP agent (listed [C1]); can itself wrap Claude Code and Codex over ACP [G1] | many | Apache-2.0 (**unverified**) | its ACP providers cannot resume sessions [G1] |
| **OpenHands** | ACP agent (listed [C1]); Python SDK and REST agent server [H1] | many, incl. Ollama | MIT (secondary sources only) | Python; heavier; Ollama needs `OLLAMA_CONTEXT_LENGTH` of at least 22000 [H2] |
| **Gemini CLI** 0.63.0 (installed) | `gemini --acp`, `--output-format stream-json` | Google | Apache-2.0 (**unverified**) | free tier exists; not asked for, but costs one registry line |
| **Aider** | Python scripting and `--message`; no JSON event stream or ACP found | many | Apache-2.0 (**unverified**) | not on the ACP list [C1]; skip |

opencode is the best "many providers" pick: one install, one ACP command, and its HTTP API is a fallback if ACP misses
something.

### (d) Agent Client Protocol (ACP)

JSON-RPC 2.0, agent runs as a child process on stdio. Zed made it; the agents page lists 42 agents [C1].
TS client library `@agentclientprotocol/sdk` 1.8.0, Apache-2.0. Checked against its bundled schema:

| UI feature | ACP |
|---|---|
| Streaming text, thinking | `session/update`: `agent_message_chunk`, `agent_thought_chunk` |
| Tool lines, files changed | `tool_call`, `tool_call_update` (kind: read, edit, delete, move, ...; locations) |
| Permission cards | client method `session/request_permission`; options `allow_once`, `allow_always`, `reject_once`, `reject_always` |
| Question cards | `elicitation/create` (needs the capability); otherwise none |
| Mission panel | `plan` updates (entries with status) |
| Crew cards | `subagent_update`, `state_update`: **marked UNSTABLE** in the schema |
| Context gauge | `usage_update { used, size, cost? }` |
| Compress | `compaction_update`; no standard "compact now" request |
| Modes, models, effort | `session/set_mode`, `session/set_model`, `session/set_config_option`, `current_mode_update` |
| "/" menu | `available_commands_update` |
| History, resume | `session/list`, `session/load`, `session/resume` (each behind a capability) |
| Stop | `session/cancel` |
| Images | prompt content blocks (capability `image`) |
| Our mission tool | `session/new` takes `mcpServers` from the client |
| Usage meter, AUTO-CONTINUE, UNDO, MCP status | **not in the spec** |

Codex works over ACP through `@agentclientprotocol/codex-acp` 2.2.2 (Apache-2.0). Goose reports Codex over ACP
works with ChatGPT Plus/Pro [G1].

### (e) OpenRouter and local models

Never talk to these directly. Route them through a runtime:

| Want | Route |
|---|---|
| OpenRouter | opencode (`/connect`, API key) over ACP |
| Ollama, llama.cpp, LM Studio | opencode config over ACP; or Codex `--oss` |
| Free test bed for development | opencode + Ollama + a small local model: lets helpers test the ACP backend without paid prompts |

Caveat: small local models are poor at multi-step tool use, and Ollama's default context (4096) does not even fit
an agent's system prompt [H2]. The UI should show the context gauge so this is visible. Model licenses vary per model.

## 4. Recommended architecture

One `AgentBackend` interface in the server. The browser protocol stays as it is. `Tab` keeps all UI state (items,
mission, crew, busy, AUTO-CONTINUE) and turns normalized `AgentEvent`s into the same `ServerEvent`s as today.

```
browser  <-- ServerEvent / ClientEvent (unchanged) -->  Tab (UI state)
                                                         |  AgentEvent / AgentSession
                     +-----------------+-----------------+-----------------+
                     | ClaudeBackend   | AcpBackend      | CodexBackend    |
                     | Agent SDK       | stdio JSON-RPC  | app-server      |
                     | (today's code)  | opencode, codex-acp, goose, gemini | (optional, later)
```

### Interface sketch (`server/agents/types.ts`)

```ts
import type { Agent, AskQuestion, HistoryEntry, Item, McpAction, McpServer, Mission, ModelChoice,
  SlashCommandInfo, Stats, UsageResponse } from '../../shared/protocol.ts';
import type { StoredUpload } from '../uploads.ts';

// What a backend can do. The page hides what is false. Sent to the page with the tab (Info.caps).
export type Caps = {
  streaming: boolean;        // text arrives in pieces
  permissions: boolean;      // per-tool approve/deny cards
  questions: boolean;        // question cards (AskUserQuestion, requestUserInput, elicitation)
  modes: { id: string; label: string }[]; // mode picker; [] hides it
  models: boolean;
  efforts: boolean;
  subagents: 'full' | 'basic' | 'none'; // full: progress lines and token counts
  plan: 'tool' | 'native' | 'none';     // tool: our update_mission; native: agent's own plan events
  context: boolean;          // CTX gauge
  compact: boolean;          // COMPRESS button
  usageLimits: boolean;      // usage meter and AUTO-CONTINUE
  history: boolean;          // listed in HISTORY, can reopen
  undo: boolean;             // UNDO FROM HERE
  slashCommands: boolean;    // "/" menu
  mcpScreen: boolean;
  images: boolean;           // images inline (else only the saved path is sent)
  steer: boolean;            // a message sent while busy joins the running turn
};

// Normalized stream from any backend. Ids are the backend's own (tool use id, task id, request id).
export type AgentEvent =
  | { k: 'session'; id: string }                                   // session id known or changed
  | { k: 'info'; model?: string; mode?: string; effort?: string }
  | { k: 'text_start'; id: string }
  | { k: 'text_delta'; id: string; text: string }
  | { k: 'text'; id: string; text: string }                        // whole block, when not streamed
  | { k: 'tool'; id: string; name: string; input: Record<string, unknown>; parent?: string; edits?: string[] }
  | { k: 'tool_error'; id: string }
  | { k: 'permission'; id: string; tool: string; title: string; detail: string }
  | { k: 'question'; id: string; questions: AskQuestion[] }
  | { k: 'plan'; mission: Omit<Mission, 'updatedAt'> }
  | { k: 'agent'; agent: Partial<Agent> & { id: string } }        // start, progress and end of a helper
  | { k: 'context'; tokens?: number; window?: number }
  | { k: 'compacted'; pre: number; post?: number }
  | { k: 'limit'; refused: boolean; resetsAt?: number; type: string }
  | { k: 'busy'; busy: boolean }
  | { k: 'turn_end'; answered: string[] | null; ok: boolean; why?: string; ms?: number }
  | { k: 'title'; title: string }
  | { k: 'note'; text: string };

export type Answer = { allow: boolean } | { answers: Record<string, string> | null };

// One running chat. Optional methods exist only when the matching cap is true.
export interface AgentSession {
  send(msg: { id: string; text: string; files: StoredUpload[] }): void; // id = UI item id = message uuid
  interrupt(): Promise<void>;
  respond(requestId: string, answer: Answer): void;
  close(): void;
  setMode?(mode: string): Promise<void>;
  setModel?(model: string): Promise<void>;
  setEffort?(effort: string): Promise<void>;
  undo?(messageId: string, dryRun: boolean): Promise<{ ok: boolean; error?: string; files: string[]; insertions: number; deletions: number }>;
  commands?(): Promise<SlashCommandInfo[]>;
  mcpServers?(): Promise<McpServer[]>;
  mcpAction?(name: string, action: McpAction): Promise<string | undefined>;
}

export type OpenOptions = {
  cwd: string;
  sessionId?: string;     // resume
  mode?: string; model?: string; effort?: string;
  mission: (m: Omit<Mission, 'updatedAt'>) => void; // for backends that host our update_mission tool
  onEvent: (e: AgentEvent) => void;
};

export interface AgentBackend {
  id: string;             // 'claude', 'codex', 'acp:opencode', ...
  label: string;          // shown in NEW TAB and on the tab
  caps: Caps;
  // Installed? Logged in? Read-only check; never logs in. `how` = the command the user runs to fix it.
  check(): Promise<{ ok: boolean; why?: string; how?: string }>;
  open(o: OpenOptions): AgentSession;
  models?(): Promise<ModelChoice[]>;
  history?(): Promise<HistoryEntry[]>;
  loadHistory?(sessionId: string, cwd: string): Promise<{ items: Item[]; mission: Mission | null; stats: Partial<Stats> }>;
  usage?(details: boolean, fresh: boolean): Promise<UsageResponse>;
}
```

### How the Claude backend fits, unchanged

`ClaudeBackend.open()` makes the same `query()` call as `Tab.start()` today, same options, same mission MCP server,
same hook. Only the destination of each message changes:

| SDK today | Becomes |
|---|---|
| `stream_event` text deltas | `text_start`, `text_delta` |
| `assistant` text not streamed | `text` |
| `tool_use` blocks (with `parent_tool_use_id`) | `tool` (with `parent`) |
| `canUseTool` | `permission` or `question`; the resolver waits in the session until `respond()` |
| `task_started/progress/updated/notification` | `agent` |
| `rate_limit_event`, `assistant.error` | `limit` |
| `result` | `turn_end` with `user_message_uuids` |
| `session_state_changed` | `busy` |
| `system init` | `session`, `info` |
| `compact_boundary` | `compacted` |
| `getSessionInfo` title | `title` |
| `rewindFiles`, `supportedCommands`, `mcpServerStatus`, `setModel`, ... | the optional session methods |
| `listSessions`, `getSessionMessages` + `historyToItems`, `supportedModels`, usage call | backend methods |

All caps are true for Claude, so the page looks exactly as now.

### Caps per backend (expected)

| Cap | Claude | ACP (opencode) | ACP (codex-acp) | Codex app-server |
|---|---|---|---|---|
| streaming, permissions | yes | yes | yes | yes |
| questions | yes | if elicitation | **unverified** | yes |
| modes | 5 | from agent | from agent | mapped from approval + sandbox |
| models, efforts | yes | via config options | via config options | yes |
| subagents | full | none or basic (unstable) | **unverified** | basic |
| plan | tool | native | native | native |
| context | yes | if `usage_update` | **unverified** | yes |
| compact | yes | no (slash command if listed) | no | yes |
| usageLimits (meter, AUTO-CONTINUE) | yes | no | no | yes |
| history | yes | if `session/list` | if `session/list` | yes |
| undo | yes | no | no | **unverified** (`thread/revert`) |
| slashCommands | yes | yes | yes | no |
| mcpScreen | yes | no | no | yes |

### Mission panel for other agents

1. Prefer the agent's own plan events (`plan` in ACP, `turn/plan/updated` in Codex). No tool, no prompt text.
2. Only if an agent has no plan events: serve `update_mission` as an MCP server and pass it in `session/new.mcpServers`.
   Run it as a tiny stdio script (no port), or on 127.0.0.1 with a per-tab random token. Never off loopback.
3. Claude keeps its in-process SDK tool and the subagent hook, as today.

### Protocol changes (small, additive)

- `Info` gets `agent: string` and `caps: Caps`. A missing `caps` means "all on", so an old page still works.
- `new_tab` gets `agent?: string`. `HistoryEntry` gets `agent`. `GET /api/models?agent=`. `GET /api/agents` lists
  backends with `check()` results.
- Item kind `'claude'` stays on the wire (old chats, old pages). The page shows the backend's label instead of "CLAUDE".
- `MODES` stops being the only list; the mode picker reads `caps.modes`. The Claude list stays the same.
- `tabs.json` saves `agent` per tab. A tab without it is a Claude tab.

### Where agents are set up

`data/agents.json` (gitignored, per PC), for example ACP agents as `{ id, label, command, args, env }`.
Defaults: Claude always; opencode, codex-acp, gemini only when `check()` finds them. No keys in this file; each
runtime keeps its own login. The app never runs a login flow. SETTINGS > AGENTS shows status and the command to run
(`claude`, `codex login`, `opencode auth login`).

## 5. Migration, small shippable steps

Each step ships alone, passes `npx tsc --noEmit -p .` and `npm run build`, and lands through the staged
`apply-when-idle` route (PLAN.md), never by restarting a busy server.

| # | Step | Behavior change | Check |
|---|---|---|---|
| 1 | **Refactor.** Add `server/agents/types.ts`. Move all SDK code from `tab.ts` into `server/agents/claude.ts` (`ClaudeBackend`, `ClaudeSession`). `Tab` handles `AgentEvent`s only. | **None** | tsc, the AUTO-CONTINUE test adapted to feed `AgentEvent`s, a test copy on another port with `?demo=1`, then one real chat |
| 2 | Move `Tabs.history/models`, `usage.ts`, the MCP boot check and `mcp.ts` behind backend methods. Remove `tabs.liveQuery()`. | None | same; usage meter and MCP screen still work |
| 3 | Add `agent` and `caps` to `Info`. The page hides features by caps (meter, AUTO-CONTINUE banner, UNDO, COMPRESS, MCP, "/" menu, pickers, crew). | None (Claude caps all on) | demo mode with a fake backend that has caps off |
| 4 | `data/agents.json`, `GET /api/agents`, NEW TAB agent picker (only when more than one agent is ready), agent label on the tab and replies. | Picker appears only if another agent is found | demo |
| 5 | `AcpBackend` with `@agentclientprotocol/sdk`: start, prompt, stream, tools, permissions, plan, cancel, modes, models, `usage_update`, `session/list` and `session/load`. First target: `opencode acp` with a local Ollama model, so tests cost nothing. | New agent available | scripted ACP fake agent in tests; then opencode + Ollama by the owner |
| 6 | Codex over ACP: add `codex-acp` to the defaults. Owner runs `codex login` once. | Codex selectable | owner tries one chat |
| 7 | HISTORY lists chats from every backend that has `history`, with an agent tag. | HISTORY grows | demo + real |
| 8 | Optional: native `CodexBackend` on `codex app-server` for the usage meter, AUTO-CONTINUE, subagent cards, compact. Pin the Codex version; generate types at build with `codex app-server generate-ts`. | Codex gets more features | owner's pick after living with step 6 |
| 9 | Optional: generic UNDO for agents without checkpoints (snapshot changed files before each turn). | UNDO for all | needs its own design; risky on big folders |

Rules for every step: Claude stays the default; no feature may get worse for Claude tabs; a backend that fails
`check()` is hidden, not an error.

## 6. Risks

| Risk | Handling |
|---|---|
| Codex app-server and ACP subagent parts change under us | Codex native is optional (step 8); ACP crew support off unless the agent says it has it |
| Subscription terms (both vendors) | App never touches logins or tokens; users sign in with each vendor's own CLI; API keys always offered; check terms again before any public release |
| Weak local models look like a broken app | Label per tab; context gauge; a note in SETTINGS > AGENTS about model size |
| More processes, more RAM | One agent process per open tab, as today; close idle ACP processes after a timeout |
| Security: a new agent gets the same power as Claude | Same login, same 127.0.0.1 rule; stdio only, no agent ports; keep permission cards on by default for every backend |
| The `phosphor` MCP prompt text names Claude | Make `MISSION_HELP` neutral when it is used by other agents |

## 7. Open questions for the owner (2 decisions)

1. **Second backend first: generic ACP, or native Codex?**
   ACP gets Codex, opencode (OpenRouter, Ollama, ChatGPT login), Gemini and Goose with one adapter, but Codex tabs
   get no usage meter, AUTO-CONTINUE or UNDO. Native Codex gets those but only Codex, on an experimental protocol.
   **My pick: ACP first (steps 5 to 7), native Codex later only if you use Codex every day.**
2. **Agent per tab, or one agent for the whole app?**
   Per tab fits how model and mode already work, and lets a Claude tab and a local-model tab run side by side.
   One global setting is simpler but makes mixing impossible.
   **My pick: per tab, chosen in NEW TAB, default Claude.**

Not a decision, but before publishing to other people: ask Anthropic (and apply to OpenAI's Sign in with ChatGPT
open-source track) whether a self-hosted app may run their CLIs with the user's own plan login.

## Sources

Checked 2026-10-12. Items marked **unverified** in the text were not confirmed in a primary source.

- [A1] Anthropic, Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- [A2] Anthropic, Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- [A3] The New Stack, Agent SDK confusion (secondary): https://thenewstack.io/anthropic-agent-sdk-confusion/
- [O1] OpenAI, Codex app-server: https://learn.chatgpt.com/docs/app-server (was developers.openai.com/codex/app-server)
- [O2] OpenAI, Sign in with ChatGPT quickstart: https://developers.openai.com/siwc/quickstart
- [O3] OpenAI, Codex TypeScript SDK README: https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- [O4] OpenAI, Codex plan usage: https://help.openai.com/en/articles/11369540
- [O5] OpenAI, Codex for Open Source: https://developers.openai.com/codex/community/codex-for-oss
- [C1] ACP, agents list: https://agentclientprotocol.com/overview/agents
- [C2] ACP, protocol overview: https://agentclientprotocol.com/protocol/overview ; schema bundled in npm `@agentclientprotocol/sdk` 1.8.0
- [P1] opencode, providers: https://opencode.ai/docs/providers/ ; server: https://opencode.ai/docs/server/
- [G1] Goose, ACP providers: https://goose-docs.ai/docs/guides/acp-providers
- [H1] OpenHands SDK: https://docs.openhands.dev/sdk
- [H2] OpenHands, local LLMs: https://docs.openhands.dev/openhands/usage/llms/local-llms
- Local, read-only: `codex --help`, `codex app-server generate-ts` (into /tmp), `opencode --help`, `gemini --help`,
  `npm view` for package versions and licenses.
