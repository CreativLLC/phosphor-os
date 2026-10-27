// Messages between the server and the browser.
// WebSocket at /ws carries ServerEvent / ClientEvent. REST under /api/* returns the *Response types.

// effort: thinking level (Claude Code "effort"); '' = the model's default.
// auto: the tab is on AUTO, so a router picks model and effort for each message (model/effort show its last pick).
// agent: who the chat is with when it is not Claude: 'gemini' (server/geminitab.ts). The page hides what only Claude has.
export type Info = { cwd: string; model: string; permissionMode: string; effort: string; auto?: boolean; agent?: 'gemini' };

// A file the user attached. 'image' = Claude also sees it inline.
// id '' = an image from an old chat that has no saved copy (no thumbnail).
export type Attachment = { id: string; name: string; kind: 'image' | 'file'; size: number; mediaType: string };

export type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

// What the AUTO router chose for one message: model name as the picker shows it, thinking level, why.
export type RouteTag = { model: string; effort: string; reason: string };

export type Item =
  // auto: sent by AUTO-CONTINUE. route: the AUTO model choice made for this message.
  // paint: a prompt for the local image model (no UNDO: it changed no files).
  | { id: string; kind: 'user'; text: string; attachments?: Attachment[]; auto?: boolean; route?: RouteTag; paint?: boolean }
  // who: the speaker's name when it is not Claude (a local model's label, e.g. "Qwen3.6 35B MoE").
  // at: when the reply came (ms since 1970). Old saved items have none.
  | { id: string; kind: 'claude'; text: string; who?: string; at?: number }
  // body: longer text shown when the line is expanded (full command, diff).
  | { id: string; kind: 'tool'; name: string; detail: string; body?: string; error?: boolean }
  | { id: string; kind: 'note'; text: string }
  | { id: string; kind: 'perm'; tool: string; title: string; detail: string; status: 'pending' | 'allowed' | 'denied' | 'cancelled' }
  | { id: string; kind: 'ask'; questions: AskQuestion[]; status: 'pending' | 'answered' | 'cancelled'; answers?: Record<string, string> }
  | ImageItem;

// A picture from the local image model (server/imagegen.ts). file: its name in the images folder, served at
// /api/images/<file>; path: where it is on the PC. step/steps while painting; ms: time from start to the saved file.
export type ImageItem = {
  id: string;
  kind: 'image';
  status: 'queued' | 'painting' | 'done' | 'failed' | 'cancelled';
  prompt: string;
  model: string; // the picker label
  width: number;
  height: number;
  seed: number;
  steps: number;
  fast?: boolean;
  edit?: boolean; // made from an attached picture
  step?: number;
  phase?: string; // what the engine is doing now, e.g. 'Starting the engine'
  startedAt?: number;
  ms?: number;
  file?: string;
  path?: string;
  error?: string;
};

export type StepStatus = 'pending' | 'in_progress' | 'completed';

// Filled by Claude through the mcp__phosphor__update_mission tool (or its TodoWrite list).
export type Mission = {
  title: string;
  summary: string;
  steps: { label: string; status: StepStatus }[];
  updatedAt: number;
};

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

// One subagent (Task/Agent tool) run.
export type Agent = {
  id: string;
  name: string; // subagent type, e.g. "Explore", "general-purpose"
  description: string; // the short task the main Claude gave it
  status: AgentStatus;
  summary: string; // latest progress line, or the final result summary
  lastTool: string;
  toolUses: number;
  tokens: number;
  model?: string; // the model it runs on, as its own replies report it (e.g. "claude-sonnet-5-5")
  startedAt: number;
  endedAt?: number;
};

export type Stats = {
  toolCalls: number;
  filesChanged: string[]; // absolute paths written or edited this tab
  turns: number;
  turnStartedAt: number | null; // set while Claude is working
  lastTurnMs: number;
  contextTokens: number; // tokens in the last request = how full the context is
  contextWindow: number;
  cacheAt: number | null; // when the chat last called Claude: its prompt cache counts down from here (shared/cache.ts)
  cacheTtlMs: number; // how long that cache lives (5 min or 1 h); 0 = no cache (a local model, or not known yet)
  connectors?: Connector[]; // the MCP servers this chat has, and how often it used each (mission panel CONNECTORS)
  delegate?: DelegateCount; // jobs this chat handed to the local model (mission panel ROUTER)
};

// ROUTER (server/delegate.ts, docs/ROUTER-PLAN.md): jobs handed to the local model with ask_local. inTokens, outTokens:
// what the local model read and wrote (its own counts). keptOff: estimated Claude tokens of file text the server read
// for it that Claude never saw (about 4 characters a token, less the answers Claude read back; a file Claude reads
// itself later comes off again). worker: the model that did the last job. at: the last job (ms), 0 = none.
export type DelegateCount = { calls: number; failed: number; inTokens: number; outTokens: number; keptOff: number; ms: number; worker?: string; at: number };
// GET /api/router: on = a local model is set up and PHOSPHOR_ROUTER is not off; total = every chat since `since` (ms).
export type RouterResponse = { on: boolean; total: DelegateCount; since: number };

// A connector (MCP server) in one chat. status: Claude Code's (connected, failed, needs-auth, pending, disabled), or
// '' when only known from the saved chat (its process has not started yet). calls: tool calls this chat made to it.
export type Connector = { name: string; status: string; calls: number };

export type TabMeta = {
  id: string;
  title: string;
  busy: boolean;
  attention: boolean; // a permission or question is waiting for the user
  sessionId?: string;
  createdAt: number;
  resume?: Resume | null; // the plan's usage limit stopped this chat's work; it continues by itself at `at`
  project?: ProjectRef; // the project this chat belongs to, if any
};

// A project (owner's ask 2026-10-25): a named group of tabs with one shared memory file (data/projects/<id>/PROJECT.md).
// Its main chat (the lead) starts thread chats and steers them with tools (server/tab.ts); each thread is a full
// chat with its own helper agents, and reports back to the lead. parent: the lead's tab id (threads only).
// own: a thread the user opened with + CHAT (not started by the lead).
export type ProjectRef = { id: string; name: string; main: boolean; parent?: string; own?: boolean };
// How the messages between a lead and its threads start (the chat labels them by this).
export const LEAD_PREFIX = '[From the project lead] ';
export const REPORT_PREFIX = '[Thread report] ';

// AUTO-CONTINUE: when to send the chat a "continue" message (ms), and which limit stopped it
// ('five_hour', 'seven_day', ...; '' = not known).
export type Resume = { at: number; limit: string };

export type TabState = {
  meta: TabMeta;
  info: Info;
  items: Item[];
  mission: Mission | null;
  agents: Agent[];
  stats: Stats;
  activity: string; // one line: what Claude is doing right now ('' when idle)
};

export type PatchKey = 'meta' | 'info' | 'mission' | 'agents' | 'stats' | 'activity';
export type Patch = { [K in PatchKey]: { t: 'patch'; tab: string; key: K; value: TabState[K] } }[PatchKey];

// Claude Agent SDK update check (server/sdkupdate.ts). Versions are the package's; `claude` is the Claude Code
// version inside it (what the owner reads). pending: newer and inside package.json's range, can be installed.
// bigger: a newer minor/major exists; needs a code check, never installed by the button.
export type SdkUpdate = { installed: string; pending: string | null; claude: string | null; bigger: string | null; running: boolean; failed: boolean };

export type ServerEvent =
  | { t: 'hello'; tabs: TabState[] }
  | { t: 'sdk_update'; state: SdkUpdate } // sent on connect and on every change
  | { t: 'tab'; tab: TabState; req?: string } // opened or reloaded; req echoes the client's new_tab/open_session req
  | { t: 'tab_closed'; tab: string }
  | { t: 'item'; tab: string; item: Item }
  | { t: 'update'; tab: string; item: Item }
  | { t: 'delta'; tab: string; id: string; text: string }
  | Patch
  | { t: 'toast'; text: string }
  // Answer to an 'undo' request. files: what changes (dry run) or changed.
  | { t: 'undo_result'; tab: string; id: string; dryRun: boolean; ok: boolean; error?: string; files: string[]; insertions: number; deletions: number };

// bypassPermissions: no permission prompts at all. Hooks (e.g. the prod-write block) still run.
export const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;
export type Mode = (typeof MODES)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export type ClientEvent =
  | { t: 'send'; tab: string; text: string; attachments?: string[] } // ids from POST /api/upload
  | { t: 'perm'; tab: string; id: string; allow: boolean }
  | { t: 'ask'; tab: string; id: string; answers: Record<string, string> | null }
  | { t: 'stop'; tab: string }
  | { t: 'mode'; tab: string; mode: Mode }
  | { t: 'model'; tab: string; model: string }
  | { t: 'effort'; tab: string; effort: Effort }
  | { t: 'new_tab'; cwd?: string; req?: string }
  | { t: 'new_project'; name: string; req?: string }
  | { t: 'new_project_chat'; project: string; title?: string; req?: string } // + CHAT: one more chat in a project
  | { t: 'open_project'; project: string; req?: string } // PROJECTS: reopen its closed chats (none: a new lead)
  | { t: 'open_session'; sessionId: string; cwd: string; title: string; req?: string }
  | { t: 'close_tab'; tab: string }
  | { t: 'rename_tab'; tab: string; title: string }
  // Put files back to how they were before user message `id` (its item id). dryRun first to preview.
  | { t: 'undo'; tab: string; id: string; dryRun: boolean }
  // AUTO-CONTINUE: now = send the continue message now; otherwise cancel it.
  | { t: 'resume'; tab: string; now: boolean }
  // ALERTS: which tab this page shows and whether you are looking at it (visible and focused). Sent on change,
  // and every 20 s while looking. No push for a tab someone looks at (server/push.ts).
  | { t: 'presence'; tab: string | null; looking: boolean };

// POST /api/upload?name=<file name> (raw bytes) -> Attachment. GET /api/upload/<id> -> the image (images only).

// GET /api/history. A Gemini chat (agent 'gemini') has sessionId "gemini:<its agy conversation>".
export type HistoryEntry = { sessionId: string; title: string; cwd: string; lastModified: number; openTab?: string; agent?: 'gemini' };
export type HistoryResponse = { sessions: HistoryEntry[] };

// GET /api/projects: every project, open or not, newest activity first (server/projects.ts). Its open chats are the
// tabs with its ProjectRef; closed: its chats closed since, which open_project reopens (a chat never used is not kept).
export type ProjectSummary = { id: string; name: string; createdAt: number; lastActive: number; closed: { sessionId: string; title: string; main: boolean }[] };
export type ProjectsResponse = { projects: ProjectSummary[] };
// GET /api/history/search?q=words[&all=1]: chats whose own text (yours and Claude's) has every word.
export type HistorySearchResponse = { hits: { sessionId: string; snippet: string }[] };

// GET /api/models: what this account can use (from the SDK), with the thinking levels each allows.
// Model picker value for the first optional local model (scripts/setup-local-model.sh); the others are "local:<name>".
export const LOCAL_MODEL = 'local';
// Model picker value for AUTO: a router picks model and thinking level per message (server/router.ts).
export const AUTO_MODEL = 'auto';
// Model picker value for the local image model (scripts/setup-image-model.sh): messages become pictures.
export const IMAGE_MODEL = 'image';
// The local image model is IMAGE_MODEL; a cloud one is "image:<engine>:<model>" (Gemini: server/geminiimage.ts).
export const isImageModel = (v?: string): boolean => v === IMAGE_MODEL || !!v?.startsWith(`${IMAGE_MODEL}:`);
// Gemini chat models are "gemini:<agy model>", e.g. "gemini:gemini-4-argon": the tab talks to Gemini through Google's
// Antigravity CLI (server/geminitab.ts) instead of Claude.
export const isGeminiModel = (v?: string): boolean => !!v?.startsWith('gemini:');
export type ModelChoice = { value: string; label: string; description: string; resolved?: string; efforts: Effort[] };
export type ModelsResponse = { models: ModelChoice[] };

// GET /api/folders
export type FoldersResponse = { root: string; folders: { name: string; path: string }[] };

// GET /api/files/list?tab=<id>&path=<relative dir>
export type FileEntry = { name: string; path: string; dir: boolean; size: number; mtime: number };
export type FilesListResponse = { root: string; path: string; entries: FileEntry[]; total?: number }; // total: count before the 2000-entry cap

// GET /api/files/read?tab=<id>&path=<relative file>
export type FileReadResponse =
  | { path: string; kind: 'text'; text: string; size: number; truncated: boolean }
  | { path: string; kind: 'image'; url: string; size: number } // url: /api/files/raw?tab=..&path=..
  | { path: string; kind: 'binary'; size: number };

// GET /api/files/find?tab=<id>&q=<words>: files by name in the tab folder, best first (the launcher's FILES).
export type FilesFindResponse = { root: string; results: { name: string; path: string }[]; truncated: boolean };

// DICTATE (server/voice.ts). GET /api/voice -> VoiceStatusResponse. POST /api/voice/warm loads the model.
// POST /api/transcribe, body: 16 kHz mono 16-bit PCM WAV (Content-Type: audio/wav), up to maxSeconds.
export type VoiceStatusResponse = { installed: boolean; loaded: boolean; maxSeconds: number };
export type TranscribeResponse = { text: string; ms: number; seconds: number } | { error: string };
// Live DICTATE, WebSocket /ws/voice: the page sends binary frames of 16 kHz mono 16-bit PCM while you talk,
// then the text frame {"t":"end"}; closing the socket cancels. The server sends these as JSON.
// final.end / done.end: how many samples (from the start of the take) are now final.
export type VoiceLiveEvent =
  | { t: 'ready' } // model loaded (audio sent before this is kept)
  | { t: 'partial'; text: string } // preview of the phrase being spoken; replaces the last one
  | { t: 'final'; text: string; end: number; joinPrev?: boolean } // a finished phrase, decoded whole; joinPrev: the pause before it was mid-sentence, drop the period before it
  | { t: 'done'; end: number } // after "end": every phrase is final
  | { t: 'error'; error: string };

// MCP screen (server/mcp.ts). GET /api/mcp?tab=<id> -> McpResponse: the MCP servers that chat can use.
// POST /api/mcp, JSON { tab, name, action } -> McpResponse after the action. ON/OFF is saved for the chat's
// folder by Claude Code (same as /mcp in the terminal). Server configs are never sent: they can hold keys.
export type McpAction = 'reconnect' | 'enable' | 'disable';
// status: connected | pending | needs-auth | failed | disabled. source: claudeai | user | project | local | plugin | ...
// kind: how Claude Code talks to it (stdio, http, sse, claudeai-proxy).
export type McpServer = { name: string; status: string; source: string; kind: string; version?: string; error?: string; tools: string[] };
export type McpResponse = { servers: McpServer[]; error?: string };

// "/" menu. GET /api/commands?tab=<id> -> CommandsResponse: the slash commands Claude Code runs in that chat.
// builtin: Claude Code's own command (not a skill, plugin or custom command).
export type SlashCommandInfo = { name: string; description: string; hint: string; builtin: boolean };
export type CommandsResponse = { commands: SlashCommandInfo[] };

// Plan usage meter (server/usage.ts). GET /api/usage -> UsageResponse: the claude.ai plan limits of the whole
// account (every device and app), cached 60 s. GET /api/usage?details=1 also fills `stats`: Claude Code use on
// this PC, counted from its saved chats, cached 5 minutes (&fresh=1 skips that cache). From an experimental SDK
// call: available false = no numbers (API key login, or the SDK changed); error says why.
// pct: 0 to 100 of the window used. resetsAt: ms since 1970, null when not known.
export type UsageWindow = { pct: number; resetsAt: number | null };
// One "where it went" row: share of local use (0 to 100) in the last 24 h and 7 days. Rows overlap.
// kind 'trait' = a kind of use; name is then the SDK key (long_context, cache_miss, subagent_heavy, high_parallel, cron).
export type UsageShare = { kind: 'trait' | 'agent' | 'skill' | 'plugin' | 'mcp'; name: string; day: number; week: number };
export type UsageCount = { requests: number; sessions: number };
export type UsageStats = { day: UsageCount; week: UsageCount; shares: UsageShare[] };
export type UsageResponse = {
  available: boolean;
  plan: string | null; // pro, max, team, enterprise
  fiveHour: UsageWindow | null;
  week: UsageWindow | null; // all models
  models: (UsageWindow & { name: string })[]; // weekly limits for one model (Opus, Sonnet, Fable)
  // Extra usage (paid past the plan), only when turned on. used/limit: this month, whole units of currency (dollars).
  extra: { pct: number | null; used: number | null; limit: number | null; currency: string } | null;
  stats?: UsageStats | null;
  checkedAt: number; // when the plan limits were read (ms), 0 = never
  error?: string;
};

// SYS panel (server/system.ts). GET /api/system -> SystemResponse. The PC is only read while someone asks: the
// first GET starts the readers, they stop 30 s after the last one, so the first answers can hold nulls.
// POST /api/system/volume, JSON { pct?: whole number 0 to 100, muted?: boolean } -> SystemVolume, or { error }.
// Sizes in bytes, rates in bytes per second, temperatures in °C. null = not known yet, or not readable on this PC.
export type SystemVolume = { pct: number; muted: boolean };
export type SystemDisk = { name: string; label: string; used: number; total: number }; // name: "C:" or a mount point
export type SystemResponse = {
  os: string; // 'win32', 'linux', ...
  host: string;
  uptime: number; // seconds since the PC started
  sampledAt: number; // ms of the last CPU/GPU/network reading, 0 = none yet
  cpu: { name: string; threads: number; pct: number | null; cores: number[]; tempC: number | null };
  mem: { used: number; total: number };
  gpu: { name: string; pct: number | null; vramUsed: number | null; vramTotal: number | null; tempC: number | null; hotspotC: number | null } | null;
  gpuModels?: string[]; // local AI models loaded on the GPU (llama.cpp processes), by file name
  disks: SystemDisk[];
  net: { name: string; rx: number; tx: number } | null; // the busiest real network adapter
  volume: SystemVolume | null; // null: no volume control here
  note?: string; // why parts are missing
  localSpeed?: LocalSpeed; // only when a local model is set up
  painting?: Painting | null; // only when the image model is set up; null = idle
};
// The local image model at work (SYS panel). step/steps: 0 before sampling starts. ms: since the picture started.
export type Painting = { model: string; phase: string; step: number; steps: number; ms: number; queued: number };
// Local model speed (server/localmeter.ts), measured in the relay. Times in ms, speeds in tokens per second, null = not
// known. readTps: input tokens / time to first token (approximate) unless readExact (the model server's own number).
// outputTokens: the server's count when outputExact, else estimated from the stream. nowTps: live, last few seconds.
// phase only while running ('loading': waiting for the model to switch or start).
export type LocalSpeedRun = {
  model: string;
  outcome: 'running' | 'ok' | 'error' | 'cancelled';
  phase?: 'loading' | 'reading' | 'thinking' | 'writing';
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  outputExact: boolean;
  firstTokenMs: number | null;
  readTps: number | null;
  readExact: boolean;
  writeTps: number | null;
  nowTps: number | null;
  totalMs: number;
  endedAt: number | null;
};
// recent: middle values of the last `count` (up to 5) finished requests.
export type LocalSpeed = { live: LocalSpeedRun | null; last: LocalSpeedRun | null; recent: { count: number; writeTps: number | null; readTps: number | null; firstTokenMs: number | null } | null };
// ALERTS (server/push.ts, web/src/alerts.ts, web/public/sw.js): Web Push when a turn ends (DONE) or Claude waits
// for you (NEEDS YOU). GET /api/push -> PushStatusResponse (the VAPID public key only; the private key stays on the PC).
// POST /api/push/subscribe { subscription: PushSubscriptionJSON, id?, oldEndpoint?, prefs? } -> { id }
// POST /api/push/unsubscribe { id } -> { ok }. POST /api/push/prefs { id, done?, needs?, quiet?, label? } -> { device }.
// POST /api/push/test { id } -> { ok, status?, error? }.
// quiet: no alerts from `from` to `to` ('HH:MM', the PC's clock; may wrap past midnight). null = off.
export type PushPrefs = { done: boolean; needs: boolean; quiet: { from: string; to: string } | null };
// service: whose push service carries it (Mozilla, Google, Microsoft, Apple). Endpoints are not sent to the page.
export type PushDevice = { id: string; label: string; service: string; prefs: PushPrefs; createdAt: number; lastOkAt: number | null; lastError: string | null };
export type PushStatusResponse = { publicKey: string; devices: PushDevice[] };
// What the service worker gets, encrypted end to end (RFC 8291): no chat text, no file paths.
export type PushPayload = { k: 'done' | 'needs' | 'test'; tab: string; title: string; body: string; at: number };
// Boot screen checks (server/bootcheck.ts). GET /api/bootcheck -> BootCheckResponse, cached about 30 s.
// Only checks that apply are listed (no Nextcloud line when the workspace is not in a Nextcloud folder;
// no MCP line unless a chat's Claude process is already running). detail is short, plain text.
export type BootCheck = { id: 'tailscale' | 'disk' | 'nextcloud' | 'mcp'; label: string; state: 'ok' | 'warn' | 'fail'; detail: string };
export type BootCheckResponse = { checks: BootCheck[]; checkedAt: number; ms: number };
// TODAY panel (server/calendar.ts). GET /api/today -> TodayResponse. Events are calendar occurrences from today on
// (start/end are ISO strings; all-day events run from local midnight to local midnight, end excluded). The server keeps
// the same events in ~/.local/state/phosphor-os/calendar.json. `offline`: the last fetch failed, the list is the last good one.
// `reminders` are the owner's pending Omarchy reminders (at = epoch ms); empty where Omarchy is not installed.
// `edit`: the event's page in Google Calendar (a link to open in the browser; nothing is changed from here). Absent for non-Google calendars.
export type CalendarEvent = { start: string; end: string; allDay: boolean; title: string; location: string; description: string; calendar: string; edit?: string };
export type TodayReminder = { label: string; at: number };
// Month view: GET /api/calendar?from=<ms>&to=<ms> (slice up to 70 days). `calendars` are the calendar names in order (an
// event's `calendar` is one of them; its place is the calendar's number). rangeFrom..rangeTo (ms, end excluded) is the
// span the server keeps; days outside it have no data. Descriptions are cut to 1000 characters. `newUrl` (here and in
// TodayResponse): start of a Google Calendar draft address, "YYYYMMDD/YYYYMMDD" appended; null with no Google calendar.
export type CalendarRangeResponse = { configured: boolean; offline: boolean; updated: number | null; calendars: string[]; rangeFrom: number; rangeTo: number; newUrl: string | null; events: CalendarEvent[] };
export type TodayResponse = { configured: boolean; offline: boolean; updated: number | null; newUrl: string | null; events: CalendarEvent[]; reminders: TodayReminder[] };
