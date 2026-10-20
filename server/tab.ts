import {
  createSdkMcpServer,
  filterEscalatingDefaultMode,
  getSessionInfo,
  getSessionMessages,
  query,
  renameSession,
  resolveSettings,
  tool,
  type CanUseTool,
  type HookCallback,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { appendFile, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IMAGE_MODEL, type Agent, type AskQuestion, type Attachment, type Effort, type ImageItem, type Item, type McpAction, type McpServer, type Mission, type Mode, type ModelsResponse, type PatchKey, type Resume, type ServerEvent, type SlashCommandInfo, type Stats, type TabState } from '../shared/protocol.ts';
import { clampEffort, decide, type RouteDecision } from '../shared/router.ts';
import { DATA_DIR, imageModel, localChoice, localModel } from './config.ts';
import { painter, type Painter } from './imagegen.ts';
import { editSize, imageSize, parseImageOptions, STEPS } from './imageopts.ts';
import { LOCAL_RELAY_PORT, localLoaded } from './localrelay.ts';
import { routeMessage } from './router.ts';
import { ATTACH_HEADER, cleanUserText } from './transcripts.ts';
import { getUpload, UPLOADS_DIR, type StoredUpload } from './uploads.ts';

// Claude Code started against the local llama.cpp server. Every model name it might use (title, helper agents) maps to it.
const localEnv = (m: NonNullable<typeof localModel>, name: string) => ({
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${LOCAL_RELAY_PORT}`, // via the relay (server/localrelay.ts), which sets the Qwen thinking level
  ANTHROPIC_AUTH_TOKEN: m.key,
  ANTHROPIC_DEFAULT_OPUS_MODEL: name,
  ANTHROPIC_DEFAULT_SONNET_MODEL: name,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: name,
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(m.contexts[name] ?? m.context), // the local window is smaller than the 200k Claude Code assumes
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});

const MISSION_TOOL = 'mcp__phosphor__update_mission';
// Chats from before the rename (Retro Claude) called it by its old name; their history still shows the panel.
const isMissionTool = (name: string) => name === MISSION_TOOL || name === 'mcp__retro__update_mission';

// The mission panel shows the main Claude's plan only. Subagents see the same tool (they inherit MCP
// servers), and their calls replaced the owner's panel (2026-10-11), so a subagent's call is refused
// with a reason; onToolUse still copies its title onto that subagent's crew card.
const onlyMainMission: HookCallback = async (input) =>
  'agent_id' in input && input.agent_id
    ? {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'The mission panel belongs to the main Claude. Do not call this tool again; report progress in your reply.',
        },
      }
    : {};

const MISSION_HELP = `You are running inside Phosphor-OS, a custom UI on the user's PC and phone. It shows a progress bar and a mission panel that read the ${MISSION_TOOL} tool.
For any task with more than one step: call it at the start with a short title, a plain-words summary of the task (one or two short sentences), and the step list. Call it again each time a step starts or finishes, or the plan changes. Keep exactly one step in_progress while you work. Skip it for quick questions and one-step answers.`;

type Run = { inbox: SDKUserMessage[]; wake?: () => void; closed: boolean };

// AUTO-CONTINUE (owner's ask 2026-10-12): when the plan's usage limit stops this chat's work (its own turn or
// its helper agents), the chat goes on by itself once the limit resets: one message, shown as AUTO. Without
// it, a night of agent work stopped at the limit and sat idle for hours after the reset.
// Off with PHOSPHOR_AUTO_CONTINUE=off in .env. Any message the owner sends cancels a waiting auto-continue.
export const AUTO_CONTINUE_TEXT =
  'Auto-continue: the plan usage limit has reset. Continue where you left off, and resume any helper agents the limit stopped.';
const RESUME_MARGIN_MS = 90_000; // after the reset time, so the first request isn't refused again
const RESUME_RETRY_MS = 30 * 60_000; // reset time unknown: try again this much later
type Waiter = { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; title: string };

export type TabInit = { id?: string; cwd: string; title?: string; sessionId?: string; createdAt?: number; mode?: Mode; model?: string; effort?: Effort; auto?: boolean; agents?: Agent[]; resume?: Resume | null; images?: SavedImage[] };

// The image model's prompts and pictures are not in Claude Code's transcript: the tab saves them (tabs.json), each
// with the id of the last transcript message before it, so a reload puts them back in the same place.
export type SavedImage = { after: string | null; item: Item };

const emptyStats = (): Stats => ({ toolCalls: 0, filesChanged: [], turns: 0, turnStartedAt: null, lastTurnMs: 0, contextTokens: 0, contextWindow: 0 });

// One chat tab = one Claude Code session.

// Who wrote a reply, for the label over it: a local model's own name from the picker ("Qwen3.6 35B MoE"), or
// undefined for Claude (and for messages Claude Code makes itself, "<synthetic>"). Old chats keep their names.
function speakerFor(model: string | undefined): string | undefined {
  if (!model || model.startsWith('claude') || model === '<synthetic>' || ['opus', 'sonnet', 'haiku'].includes(model)) return undefined;
  const local = localModel?.models.find((m) => m.name === model);
  return (local?.label ?? model).replace(/\s*\(local\)\s*$/i, '');
}

export class Tab {
  state: TabState;
  onPersist?: () => void; // title or session id changed
  private q?: Query;
  private run?: Run;
  private waiters = new Map<string, Waiter>();
  private textId?: string;
  private textWho?: string; // the speaker of the message being streamed (speakerFor)
  // Messages you sent that Claude has not finished answering. Busy = any left, or Claude working on
  // its own (e.g. a background agent reported back). One reply ending doesn't mean all are done.
  private waitingFor = new Set<string>();
  private streamedMsgs = new Set<string>();
  private agentByToolUse = new Map<string, string>();
  private pendingMode?: Mode;
  private pendingModel?: string;
  private pendingEffort?: Effort;
  private auto: boolean; // AUTO model: the router picks model and effort for each message
  private routing = 0; // messages waiting for the router
  private stopEpoch = 0; // STOP bumps it: messages still waiting for the router are dropped
  private sendQueue: Promise<void> = Promise.resolve(); // keeps messages in order while the router works
  private gone = false; // the tab was closed by the owner
  private autoTitle: boolean;
  private undoNote?: string; // told to Claude with the next message after an UNDO
  private titleFromPrompt = false; // title is the first words typed; swap in Claude's chat title when it exists
  private savedTitle?: string; // the name last written to the chat's session file (what HISTORY shows)
  // The plan's limit as last reported (rate_limit_event): refused or not, and when it resets (ms).
  private limit: { refused: boolean; resetsAt?: number; type: string } = { refused: false, type: '' };
  private imageLog: SavedImage[];
  private painting = 0; // pictures of this tab not finished yet
  private paintEpoch = 0; // STOP bumps it: pictures still waiting are dropped
  private paintNote: string[] = []; // pictures made since Claude last heard: told with the next message to Claude

  constructor(private emit: (ev: ServerEvent) => void, init: TabInit) {
    this.autoTitle = !init.title || init.title === 'New chat';
    this.state = {
      meta: { id: init.id ?? randomUUID(), title: init.title ?? 'New chat', busy: false, attention: false, sessionId: init.sessionId, createdAt: init.createdAt ?? Date.now(), resume: init.resume ?? null },
      info: { cwd: init.cwd, model: init.model ?? '', permissionMode: init.mode ?? '', effort: init.effort ?? '', auto: init.auto ?? false },
      items: [],
      mission: null,
      // Agent cards are saved with the tab; ones still running when the app stopped are marked stopped.
      // One card per agent id: older saves have duplicates from resumed agents (see task_started).
      agents: (init.agents ?? [])
        .filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i)
        .map((a) =>
          a.status === 'running' ? { ...a, status: 'stopped' as const, summary: a.summary || 'Stopped when the app restarted.', endedAt: a.endedAt ?? Date.now() } : a,
        ),
      stats: emptyStats(),
      activity: '',
    };
    // A picture that was being made when the app stopped is not coming.
    this.imageLog = (init.images ?? []).map((e) =>
      e.item.kind === 'image' && (e.item.status === 'queued' || e.item.status === 'painting') ? { ...e, item: { ...e.item, status: 'failed', error: 'Stopped when the app restarted.', phase: undefined } } : e,
    );
    this.state.items = this.imageLog.map((e) => e.item);
    this.pendingMode = init.mode;
    this.pendingModel = init.model;
    this.pendingEffort = init.effort;
    this.auto = init.auto ?? false;
  }

  get id(): string {
    return this.state.meta.id;
  }

  // The mode the user picked in this tab (saved with the tab), if any.
  get mode(): Mode | undefined {
    return this.pendingMode;
  }

  get model(): string | undefined {
    return this.pendingModel;
  }

  get effort(): Effort | undefined {
    return this.pendingEffort;
  }

  get autoModel(): boolean {
    return this.auto;
  }

  // The local image model and its painter (server/imagegen.ts); tests hand in fakes.
  static images: { painter: Pick<Painter, 'paint'>; model: Pick<NonNullable<typeof imageModel>, 'label' | 'edit' | 'turbo'> } | undefined = painter && imageModel ? { painter, model: imageModel } : undefined;

  // For the AUTO tag: the model's name as the picker shows it.
  static models?: () => Promise<ModelsResponse>;
  static knownModels?: () => ModelsResponse | undefined; // the list if it has already loaded

  // This chat's Claude process, if it is running (the usage meter asks it; nothing is sent).
  get query(): Query | undefined {
    return this.q;
  }

  // Model and permission mode from Claude Code settings, so the UI shows them before the first turn.
  static lastModel = '';
  // Commands that only work in a terminal (Claude Code lists them at the first turn); left out of the "/" menu.
  static terminalCommands = new Set<string>();
  async prefillInfo(): Promise<void> {
    if (this.state.info.model && this.state.info.permissionMode && this.state.info.effort) return;
    try {
      const resolved = await resolveSettings({ cwd: this.state.info.cwd });
      const mode = filterEscalatingDefaultMode(resolved).permissions?.defaultMode ?? 'default';
      const model = resolved.effective.model ?? Tab.lastModel;
      const effort = resolved.effective.effortLevel ?? '';
      this.state.info = {
        ...this.state.info,
        model: this.state.info.model || model,
        permissionMode: this.state.info.permissionMode || this.pendingMode || mode,
        effort: this.state.info.effort || this.pendingEffort || effort,
      };
      this.patch('info');
    } catch {
      /* settings unreadable: the first turn fills these in */
    }
  }

  // Rebuild the chat from Claude Code's saved transcript (works for terminal sessions too).
  async loadHistory(): Promise<void> {
    const sid = this.state.meta.sessionId;
    if (!sid) return;
    // A chat started in another folder (e.g. the terminal at the workspace root) is saved under that
    // folder, not this tab's: if the tab's folder has nothing, search all of Claude Code's saved chats.
    let msgs = await getSessionMessages(sid, { dir: this.state.info.cwd });
    if (!msgs.length) msgs = await getSessionMessages(sid);
    const { items, mission, stats } = historyToItems(msgs);
    this.state.items = mergeImages(items, this.imageLog);
    this.state.mission = mission;
    Object.assign(this.state.stats, stats);
  }

  send(text: string, files: StoredUpload[] = [], auto = false): void {
    if (!auto) this.clearResume(); // the owner took over
    if (this.pendingModel === IMAGE_MODEL && Tab.images && !auto) return this.paint(text, files);
    const first = this.state.items.every((i) => i.kind !== 'user' || i.paint);
    this.firstWordsTitle(text, files);
    const attachments = files.map(({ path: _p, ...a }) => a);
    // The item id is also the message uuid: file checkpoints (UNDO) are keyed by it.
    const id = randomUUID();
    const lastReply = [...this.state.items].reverse().find((i) => i.kind === 'claude')?.text ?? '';
    const midTurn = this.state.meta.busy; // read before setBusy below
    const epoch = this.stopEpoch;
    const stopped = () => epoch !== this.stopEpoch;
    this.waitingFor.add(id);
    this.add({ id, kind: 'user', text, ...(attachments.length ? { attachments } : {}), ...(auto ? { auto } : {}) });
    const paintNote = this.paintNote.length
      ? `[Note from the Phosphor-OS app: in this chat the user made pictures with the local image model (${Tab.images?.model.label ?? 'image model'}). Saved files:\n${this.paintNote.join('\n')}]`
      : '';
    const forClaude = [this.undoNote, paintNote, text].filter(Boolean).join('\n\n');
    this.undoNote = undefined;
    this.paintNote = [];
    this.setBusy(true);
    const deliver = () => {
      if (this.gone) return;
      if (!this.q) this.start();
      this.run!.inbox.push({ type: 'user', uuid: id, message: { role: 'user', content: userContent(forClaude, files) }, parent_tool_use_id: null });
      this.run!.wake?.();
      void this.watchLocalLoad();
    };
    // AUTO: the router (a second or two) picks model and effort first; messages behind it wait their turn.
    // Not while Claude is mid-turn: a message then joins the running task, and a switch would land inside it.
    const routed = this.auto && !auto && !midTurn;
    if (!routed && this.routing === 0) return deliver();
    if (routed) this.setActivity('Choosing a model');
    this.routing++;
    this.sendQueue = this.sendQueue
      .then(async () => {
        let picked: RouteDecision | undefined;
        if (routed && !stopped()) {
          picked = await this.route(id, text, attachments.length, first, lastReply, stopped).catch((e) => {
            console.warn('AUTO route failed:', e);
            return undefined;
          });
          // Routing is over: the panel must not keep saying "Choosing a model" while Claude thinks, and a switch
          // between the local model and Claude (setModel) marks the tab idle, though this message is on its way.
          if (!this.gone && !stopped()) {
            this.setBusy(true);
            this.setActivity('Thinking');
          }
        }
        if (stopped()) {
          this.waitingFor.delete(id);
          if (this.waitingFor.size === 0) this.setBusy(false);
          if (!this.gone) this.note('Stopped before it was sent.');
          return;
        }
        deliver();
        if (picked) void this.tagRoute(id, picked); // after delivery: the model list may be slow
      })
      .finally(() => this.routing--);
  }

  // The chat's name from its first words, while it has no name of its own yet.
  private firstWordsTitle(text: string, files: StoredUpload[]): void {
    if (!this.autoTitle || this.state.items.some((i) => i.kind === 'user')) return;
    this.state.meta.title = shortTitle(text || files[0]?.name || 'Attachment');
    this.autoTitle = false;
    this.titleFromPrompt = true;
    this.patch('meta');
    this.onPersist?.();
  }

  // The tab's model is the image model: the text is a picture's description (server/imagegen.ts). Pictures wait
  // their turn; the chat shows each one as it is painted.
  private paint(text: string, files: StoredUpload[]): void {
    const { painter: p, model: im } = Tab.images!;
    this.firstWordsTitle(text, files);
    const after = [...this.state.items].reverse().find((i) => i.kind === 'user' && !i.paint)?.id ?? null;
    const log = (item: Item) => {
      this.imageLog.push({ after, item });
      this.add(item);
    };
    const attachments = files.map(({ path: _p, ...a }) => a);
    log({ id: randomUUID(), kind: 'user', text, paint: true, ...(attachments.length ? { attachments } : {}) });
    const opts = parseImageOptions(text);
    const notes = [...opts.notes];
    const pictures = files.filter((f) => f.kind === 'image');
    if (files.length > pictures.length) notes.push('Only pictures can go to the image model; the other files were left out.');
    let ref: Buffer | undefined;
    if (pictures.length && !im.edit) notes.push(`${im.label} cannot change a picture you attach: it painted a new one from your words only.`);
    else if (pictures.length) {
      if (pictures.length > 1) notes.push('Only the first picture is used.');
      ref = readFileSync(pictures[0].path);
      const size = imageSize(ref);
      if (size && !opts.shaped) [opts.width, opts.height] = editSize(size[0], size[1], opts.hd);
    }
    if (opts.fast && !im.turbo) {
      // No Turbo installed: the full model is the only mode.
      opts.fast = false;
      if (!opts.stepsSet) opts.steps = STEPS;
    }
    if (notes.length) log({ id: randomUUID(), kind: 'note', text: notes.join(' ') });
    if (!opts.prompt) {
      this.onPersist?.();
      return log({ id: randomUUID(), kind: 'note', text: 'Nothing to paint: write what the picture should show.' });
    }
    const id = randomUUID();
    const item: ImageItem = { id, kind: 'image', status: 'queued', prompt: opts.prompt, model: im.label, width: opts.width, height: opts.height, seed: opts.seed, steps: opts.steps, ...(opts.fast ? { fast: true } : {}), ...(ref ? { edit: true } : {}) };
    log(item);
    this.onPersist?.();
    const epoch = this.paintEpoch;
    this.painting++;
    this.setBusy(true);
    this.setActivity('Waiting for the GPU');
    void p
      .paint({
        opts,
        ref,
        cancelled: () => this.gone || epoch !== this.paintEpoch,
        update: (fields) => {
          if (this.gone) return;
          this.patchItem(id, fields);
          const step = fields.step ? ` ${fields.step}/${opts.steps}` : '';
          if (fields.phase) this.setActivity(`${fields.phase}${fields.phase === 'Painting' ? step : ''}`);
        },
      })
      .then((r) => {
        if (r.status === 'done') {
          this.patchItem(id, { status: 'done', file: r.file, path: r.path, ms: r.ms, phase: undefined, step: undefined });
          this.paintNote.push(`${r.path} (prompt: ${opts.prompt.slice(0, 200)})`);
        } else if (r.status === 'failed') this.patchItem(id, { status: 'failed', error: r.error, phase: undefined });
        else this.patchItem(id, { status: 'cancelled', phase: undefined });
      })
      .finally(() => {
        this.onPersist?.();
        if (--this.painting === 0 && this.waitingFor.size === 0) this.setBusy(false);
      });
  }

  // Saved with the tab (tabs.json).
  get images(): SavedImage[] {
    return this.imageLog.slice(-200);
  }

  // The local server loads a model when a request names one it has not loaded (about 30 s): say so while the first message waits.
  private async watchLocalLoad(): Promise<void> {
    const local = localChoice(this.pendingModel);
    if (!local || (await localLoaded(local.name))) return;
    const LOADING = 'Loading local model';
    this.setActivity(LOADING);
    for (let i = 0; i < 90 && !this.gone && this.state.activity === LOADING; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await localLoaded(local.name)) break;
    }
    if (!this.gone && this.state.activity === LOADING) this.setActivity(this.state.meta.busy ? 'Thinking' : '');
  }

  // AUTO: ask the router, apply what shared/router.ts decides, tag the message, log the decision.
  private async route(id: string, text: string, attachments: number, first: boolean, lastReply: string, stopped: () => boolean): Promise<RouteDecision | undefined> {
    const current = first ? null : { model: this.pendingModel ?? '', effort: this.pendingEffort ?? '' };
    const turns = this.state.items.filter((i) => i.kind === 'user').length - 1;
    const r = await routeMessage({ text, attachments, title: this.state.meta.title, turns, current, lastReply });
    if (stopped()) return;
    const d = decide(r.pick, current, r.error);
    if (d.model !== this.pendingModel) await this.setModel(d.model, true);
    // Held to the efforts the chosen model supports (only when the model list is already known; never waited for).
    const supported = Tab.knownModels?.()?.models.find((m) => m.value === d.model)?.efforts;
    const effort = supported ? clampEffort(d.effort, supported) : d.effort;
    const applied = { ...d, effort };
    if (effort && effort !== this.pendingEffort) await this.setEffort(effort as Effort, true);
    const line = { time: new Date().toISOString(), tab: this.id, msg: text.slice(0, 120), pick: r.pick, applied: { model: d.model, effort }, reason: d.reason, ms: r.ms, ...(r.error ? { error: r.error } : {}) };
    appendFile(join(DATA_DIR, 'auto-router.jsonl'), JSON.stringify(line) + '\n', () => {}); // tuning log; a failed write is not worth a warning
    return applied;
  }

  // The AUTO tag on the message: the model's name as the picker shows it.
  private async tagRoute(id: string, d: RouteDecision): Promise<void> {
    const label = (await Tab.models?.().catch(() => undefined))?.models.find((m) => m.value === d.model)?.label ?? d.model;
    if (!this.gone) this.patchItem(id, { route: { model: label, effort: d.effort, reason: d.reason } });
  }

  async stop(): Promise<void> {
    this.stopEpoch++;
    this.paintEpoch++;
    await this.q?.interrupt().catch(() => {});
  }

  async setMode(mode: Mode): Promise<void> {
    this.pendingMode = mode;
    if (this.q) await this.q.setPermissionMode(mode).catch(() => {});
    this.state.info.permissionMode = mode;
    this.patch('info');
    this.onPersist?.();
  }

  // UNDO: put files back to how they were before user message `id` (Claude Code file checkpoints).
  async undo(id: string, dryRun: boolean): Promise<void> {
    const reply = (r: { ok?: boolean; error?: string; files?: string[]; insertions?: number; deletions?: number }) =>
      this.emit({ t: 'undo_result', tab: this.id, id, dryRun, ok: false, files: [], insertions: 0, deletions: 0, ...r });
    if (this.state.meta.busy) return reply({ error: 'Claude is still working. Wait until it is done, or press STOP.' });
    const item = this.state.items.find((i) => i.id === id);
    if (item?.kind !== 'user') return reply({ error: 'That message is not in this chat.' });
    if (!this.q) this.start(); // reconnects to the saved session without sending anything
    try {
      const r = await this.q!.rewindFiles(id, { dryRun });
      if (!r.canRewind) return reply({ error: r.error ?? 'Nothing to undo from that message.' });
      reply({ ok: true, files: r.filesChanged ?? [], insertions: r.insertions ?? 0, deletions: r.deletions ?? 0 });
      if (!dryRun) {
        const what = shortTitle(item.text || item.attachments?.[0]?.name || 'attachment');
        this.note(`UNDO: files put back to before "${what}".`);
        this.undoNote = `[Note from the Phosphor-OS app: the user pressed UNDO. Every file change made since their message "${what}" was reverted; those files are back to how they were before that message.]`;
      }
    } catch (e) {
      reply({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // AUTO on or off. On: the next message is routed. Off: the tab keeps the model and effort it has now.
  setAuto(on: boolean): void {
    this.auto = on;
    this.state.info.auto = on;
    this.patch('info');
    this.onPersist?.();
  }

  // The owner picking a model leaves AUTO; the router's own switches (byRouter) do not.
  async setModel(model: string, byRouter = false): Promise<void> {
    if (!byRouter) this.auto = false;
    // Each local model is its own Claude Code process too: its model name is fixed in that process's environment.
    const switching = !!this.q && localChoice(this.pendingModel)?.name !== localChoice(model)?.name;
    this.pendingModel = model;
    if (switching) {
      // Claude and the local models are other servers or names (base URL, model env), so Claude's process starts again; the next message resumes the chat.
      await this.q?.interrupt().catch(() => {}); // not stop(): a message waiting for the router is the one being sent
      this.close(true);
      this.setBusy(false);
    } else if (this.q && model !== IMAGE_MODEL) await this.q.setModel(model).catch(() => {}); // pictures do not use Claude's process
    this.state.info.model = model;
    this.state.info.auto = this.auto;
    this.patch('info');
    this.onPersist?.();
  }

  // Thinking level. Mid-chat it goes through the flag settings layer, like /effort.
  async setEffort(effort: Effort, byRouter = false): Promise<void> {
    if (!byRouter) this.auto = false;
    this.pendingEffort = effort;
    if (this.q) await this.q.applyFlagSettings({ effortLevel: effort }).catch(() => {});
    this.state.info.effort = effort;
    this.state.info.auto = this.auto;
    this.patch('info');
    this.onPersist?.();
  }

  // MCP servers this chat can use, for the MCP screen. Starts Claude's process if needed (nothing is sent).
  // Only safe fields go to the page: a server's config can hold keys.
  async mcpServers(): Promise<McpServer[]> {
    if (!this.q) this.start();
    const list = await this.q!.mcpServerStatus();
    return list
      .filter((s) => s.source !== 'sdk' && s.name !== 'phosphor') // this app's own mission tool
      .map((s) => ({
        name: s.name,
        status: s.status,
        source: s.source ?? s.scope ?? '',
        kind: s.config?.type ?? '',
        ...(s.serverInfo?.version ? { version: s.serverInfo.version } : {}),
        ...(s.error ? { error: s.error.slice(0, 300) } : {}),
        tools: (s.tools ?? []).map((t) => t.name),
      }));
  }

  // RECONNECT, or ON/OFF. Claude Code saves ON/OFF for this folder, like /mcp in the terminal.
  // Returns an error to show, if any.
  async mcpAction(name: string, action: McpAction): Promise<string | undefined> {
    if (!this.q) this.start();
    try {
      if (action === 'reconnect') await this.q!.reconnectMcpServer(name);
      else await this.q!.toggleMcpServer(name, action === 'enable');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A server that needs a login "fails" to connect with that status; the list shows it, so it is not an error.
      return /needs-auth/.test(msg) ? undefined : msg;
    }
  }

  // Slash commands Claude Code runs in this chat (built-in, skills, plugins, custom), for the "/" menu.
  async commands(): Promise<SlashCommandInfo[]> {
    if (!this.q) this.start();
    const seen = new Set<string>();
    const out: SlashCommandInfo[] = [];
    // When two rows share a name, Claude Code runs its own (builtin) one: keep that.
    const list = [...(await this.q!.supportedCommands())].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin));
    for (const c of list) {
      if (seen.has(c.name) || c.name.startsWith('_') || Tab.terminalCommands.has(c.name)) continue;
      seen.add(c.name);
      out.push({ name: c.name, description: c.description ?? '', hint: c.argumentHint ?? '', builtin: !!c.builtin });
    }
    return out;
  }

  rename(title: string): void {
    this.state.meta.title = title.slice(0, 60);
    this.autoTitle = false;
    this.titleFromPrompt = false;
    this.patch('meta');
    this.onPersist?.();
    this.saveSessionTitle();
  }

  // Write the tab's name into Claude Code's session file, so HISTORY shows the same name after the tab closes.
  // Once per change. A new chat has no session yet: init calls this again when the id arrives. A first-words
  // name waits for Claude's own title (once ours is saved, the SDK gives back ours instead), or for the tab to
  // close. Until then HISTORY takes the open tab's name.
  // No folder given: a chat started elsewhere (the terminal) is saved under that folder, the SDK finds it.
  private saveSessionTitle(): void {
    const sid = this.state.meta.sessionId;
    const title = this.state.meta.title;
    if (!sid || this.autoTitle || this.titleFromPrompt || title === this.savedTitle) return;
    this.savedTitle = title;
    renameSession(sid, title).catch((e) => {
      if (this.savedTitle === title) this.savedTitle = undefined;
      console.warn(`Could not save the chat name "${title}":`, e);
    });
  }

  // A tab from before a restart, or an old chat just opened: save its name once if the session file says
  // something else (auto titles were not saved before; a chat without a title shows its last prompt).
  async syncSessionTitle(): Promise<void> {
    const sid = this.state.meta.sessionId;
    if (!sid || this.autoTitle) return;
    const info = await getSessionInfo(sid).catch(() => undefined);
    if (!info) return; // no session file (yet)
    if (info.customTitle === this.state.meta.title) this.savedTitle = info.customTitle;
    else this.saveSessionTitle();
  }

  close(restarting = false): void {
    if (!restarting) {
      this.gone = true;
      this.titleFromPrompt = false; // no more waiting for Claude's title: save the first-words name
      this.saveSessionTitle();
    }
    if (this.run) {
      this.run.closed = true;
      this.run.wake?.();
    }
    this.q?.close();
    this.q = undefined;
    this.run = undefined;
    for (const id of [...this.waiters.keys()]) this.answerPermission(id, false);
  }

  answerPermission(id: string, allow: boolean): void {
    const w = this.waiters.get(id);
    if (!w) return;
    this.waiters.delete(id);
    this.patchItem(id, { status: allow ? 'allowed' : 'denied' });
    this.updateAttention();
    this.setActivity(allow ? 'Working' : 'Told no. Rethinking');
    w.resolve(allow ? { behavior: 'allow', updatedInput: w.input } : { behavior: 'deny', message: 'The user denied this in the Phosphor-OS app.' });
  }

  answerQuestions(id: string, answers: Record<string, string> | null): void {
    const w = this.waiters.get(id);
    if (!w) return;
    this.waiters.delete(id);
    this.patchItem(id, { status: answers ? 'answered' : 'cancelled', answers: answers ?? undefined });
    this.updateAttention();
    this.setActivity('Working');
    w.resolve(answers ? { behavior: 'allow', updatedInput: { ...w.input, answers } } : { behavior: 'deny', message: 'The user skipped the question.' });
  }

  private start(): void {
    const local = localChoice(this.pendingModel);
    const run: Run = { inbox: [], closed: false };
    this.run = run;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (!run.closed) {
        const next = run.inbox.shift();
        if (next) yield next;
        else await new Promise<void>((r) => (run.wake = r));
      }
    }
    this.q = query({
      prompt: input(),
      options: {
        cwd: this.state.info.cwd,
        additionalDirectories: [UPLOADS_DIR], // attachments: Claude may read them without asking
        resume: this.state.meta.sessionId,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: MISSION_HELP },
        includePartialMessages: true,
        agentProgressSummaries: true,
        permissionMode: this.pendingMode,
        model: local ? local.name : this.pendingModel,
        env: local ? localEnv(localModel!, local.name) : undefined,
        effort: this.pendingEffort,
        allowDangerouslySkipPermissions: true, // lets the user pick BYPASS; nothing turns it on by itself
        enableFileCheckpointing: true, // backups before each edit, so UNDO can put files back
        canUseTool: this.canUseTool,
        mcpServers: { phosphor: this.missionServer() },
        allowedTools: [MISSION_TOOL],
        hooks: { PreToolUse: [{ matcher: MISSION_TOOL, hooks: [onlyMainMission] }] },
      },
    });
    void this.pump(this.q, run);
  }

  private missionServer() {
    return createSdkMcpServer({
      name: 'phosphor',
      alwaysLoad: true,
      instructions: MISSION_HELP,
      tools: [
        tool(
          'update_mission',
          'Update the mission panel and progress bar in the Phosphor-OS UI: task title, plain-words summary, and the step list with statuses. Progress shown = completed steps / all steps.',
          {
            title: z.string().describe('Short task title, at most about 6 words'),
            summary: z.string().describe('What you are doing and why, in one or two short plain sentences'),
            steps: z.array(z.object({ label: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })),
          },
          async (args) => {
            this.setMission({ title: args.title, summary: args.summary, steps: args.steps, updatedAt: Date.now() });
            return { content: [{ type: 'text', text: 'Mission panel updated.' }] };
          },
        ),
      ],
    });
  }

  private async pump(q: Query, run: Run): Promise<void> {
    try {
      for await (const m of q) {
        if (run.closed) return;
        this.onMessage(m);
      }
    } catch (err) {
      if (run.closed) return;
      this.note(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.run === run) {
      // Claude's process ended. The next message starts it again and resumes the same session.
      this.q = undefined;
      this.run = undefined;
      this.waitingFor.clear();
      this.setBusy(false);
    }
  }

  private onMessage(m: SDKMessage): void {
    // Claude started a turn on its own (a background agent finished, a scheduled wake-up): show it working.
    if ((m.type === 'assistant' || m.type === 'stream_event') && !m.parent_tool_use_id && !this.state.meta.busy) this.setBusy(true);
    switch (m.type) {
      case 'system':
        return this.onSystem(m);
      case 'stream_event': {
        if (m.parent_tool_use_id) return;
        const ev = m.event;
        if (ev.type === 'message_start') {
          this.textId = undefined;
          this.textWho = speakerFor(ev.message.model);
          this.streamedMsgs.add(ev.message.id);
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
          this.textId = randomUUID();
          this.add({ id: this.textId, kind: 'claude', text: '', ...(this.textWho ? { who: this.textWho } : {}) });
          this.setActivity('Writing a reply');
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.textId) {
          const item = this.state.items.find((i) => i.id === this.textId);
          if (item?.kind === 'claude') item.text += ev.delta.text;
          this.emit({ t: 'delta', tab: this.id, id: this.textId, text: ev.delta.text });
        }
        return;
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info;
        // resetsAt comes in seconds; accept ms too.
        const at = info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : undefined;
        this.limit = { refused: info.status === 'rejected' && !info.isUsingOverage, resetsAt: at, type: info.rateLimitType ?? '' };
        if (this.limit.refused && (this.state.meta.resume || this.state.meta.busy || this.state.agents.some((a) => a.status === 'running'))) this.limitHit();
        return;
      }
      case 'assistant': {
        const sub = m.parent_tool_use_id;
        if (!sub && m.error === 'rate_limit') this.limitHit();
        if (sub) {
          const a = this.agent(this.agentByToolUse.get(sub) ?? '');
          if (a && m.message.model && a.model !== m.message.model) {
            a.model = m.message.model;
            this.patch('agents');
          }
        } else {
          const u = m.message.usage;
          if (u) this.state.stats.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
        for (const block of m.message.content) {
          if (block.type === 'text' && !sub && !this.streamedMsgs.has(m.message.id) && block.text.trim()) {
            const who = speakerFor(m.message.model);
            this.add({ id: randomUUID(), kind: 'claude', text: block.text, ...(who ? { who } : {}) });
          }
          if (block.type === 'tool_use') this.onToolUse(block.id, block.name, (block.input ?? {}) as Record<string, unknown>, sub);
        }
        this.patch('stats');
        return;
      }
      case 'user': {
        if (m.parent_tool_use_id || typeof m.message.content === 'string') return;
        for (const block of m.message.content) {
          if (block.type === 'tool_result' && block.is_error) this.patchItem(block.tool_use_id, { error: true });
        }
        return;
      }
      case 'result': {
        const s = this.state.stats;
        s.turns++;
        s.lastTurnMs = s.turnStartedAt ? Date.now() - s.turnStartedAt : m.duration_ms;
        s.turnStartedAt = null;
        for (const mu of Object.values(m.modelUsage ?? {})) s.contextWindow = Math.max(s.contextWindow, mu.contextWindow ?? 0);
        if (m.subtype !== 'success') this.note(`Stopped (${m.subtype.replaceAll('_', ' ')}).`);
        this.patch('stats');
        // Only idle once every message you sent has its answer.
        const r = m as { user_message_uuids?: string[]; user_message_uuid?: string };
        const answered = r.user_message_uuids ?? (r.user_message_uuid ? [r.user_message_uuid] : null);
        if (answered) for (const id of answered) this.waitingFor.delete(id);
        else this.waitingFor.clear(); // older Claude Code: no ids, so assume all answered
        if (this.waitingFor.size === 0) this.setBusy(false);
        void this.adoptSessionTitle();
        return;
      }
    }
  }

  private onSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    if (m.subtype === 'init') {
      const effort = (m as { effort?: string | null }).effort;
      // Keep the tab's own folder: init reports the shell's current folder, which moves when a command cd's
      // into a subfolder (saving that moved chats out of the workspace).
      this.state.info = { cwd: this.state.info.cwd, model: m.model, permissionMode: m.permissionMode, effort: effort ?? this.pendingEffort ?? this.state.info.effort, auto: this.auto };
      Tab.lastModel = m.model;
      if (m.terminal_slash_commands) Tab.terminalCommands = new Set(m.terminal_slash_commands);
      this.patch('info');
      if (this.state.meta.sessionId !== m.session_id) {
        this.state.meta.sessionId = m.session_id;
        this.patch('meta');
        this.onPersist?.();
        this.saveSessionTitle();
      }
    } else if (m.subtype === 'compact_boundary') {
      const c = m.compact_metadata;
      const kt = (n: number) => `${Math.round(n / 1000)}K`;
      this.note(c.post_tokens ? `Context compressed: ${kt(c.pre_tokens)} -> ${kt(c.post_tokens)} tokens.` : `Context compressed (was ${kt(c.pre_tokens)} tokens).`);
      if (c.post_tokens) {
        this.state.stats.contextTokens = c.post_tokens;
        this.patch('stats');
      }
    } else if (m.subtype === 'session_state_changed') {
      // Claude Code's own signal; 'idle' is final for the turn, background agents included.
      if (m.state === 'idle') {
        this.waitingFor.clear();
        this.setBusy(false);
      } else {
        this.setBusy(true);
      }
    } else if (m.subtype === 'status' && m.permissionMode) {
      this.state.info.permissionMode = m.permissionMode;
      this.patch('info');
    } else if (m.subtype === 'task_started') {
      const isAgent = !!m.subagent_type || !m.task_type || /agent|workflow/.test(m.task_type);
      if (!isAgent) return;
      // A stopped agent that is resumed (SendMessage) starts again under the same id: reuse its card. A second
      // card got no updates and stayed RUNNING forever (crew count 12 active with 9 real, 2026-10-12).
      const known = this.agent(m.task_id);
      if (known) {
        Object.assign(known, { status: 'running', endedAt: undefined, startedAt: Date.now(), summary: 'Resumed.' });
        if (m.tool_use_id) this.agentByToolUse.set(m.tool_use_id, m.task_id);
        this.patch('agents');
        return;
      }
      this.state.agents.push({
        id: m.task_id,
        name: m.subagent_type ?? m.workflow_name ?? 'agent',
        description: m.description,
        status: 'running',
        summary: '',
        lastTool: '',
        toolUses: 0,
        tokens: 0,
        startedAt: Date.now(),
      });
      if (m.tool_use_id) this.agentByToolUse.set(m.tool_use_id, m.task_id);
      this.patch('agents');
    } else if (m.subtype === 'task_progress') {
      const a = this.agent(m.task_id);
      if (!a) return;
      if (m.summary && !isInternalNote(m.summary)) a.summary = m.summary;
      if (m.last_tool_name) a.lastTool = friendlyTool(m.last_tool_name);
      a.toolUses = m.usage.tool_uses;
      a.tokens = m.usage.total_tokens;
      this.patch('agents');
    } else if (m.subtype === 'task_updated') {
      const a = this.agent(m.task_id);
      if (!a || !m.patch.status) return;
      a.status = m.patch.status === 'killed' ? 'stopped' : m.patch.status === 'completed' || m.patch.status === 'failed' ? m.patch.status : 'running';
      if (a.status !== 'running') a.endedAt = m.patch.end_time ?? Date.now();
      this.patch('agents');
    } else if (m.subtype === 'task_notification') {
      const a = this.agent(m.task_id);
      if (!a) return;
      a.status = m.status;
      a.endedAt = Date.now();
      if (m.summary && !isInternalNote(m.summary)) a.summary = m.summary;
      else if (a.status === 'completed') a.summary = 'Done. Report sent back.';
      if (a.status !== 'completed' && (this.limit.refused || /usage limit|session limit|rate.?limit/i.test(m.summary ?? ''))) this.limitHit();
      if (m.usage) {
        a.toolUses = m.usage.tool_uses;
        a.tokens = m.usage.total_tokens;
      }
      this.patch('agents');
    }
  }

  // Claude Code writes a short title for each chat; use it once it differs from the first prompt.
  private async adoptSessionTitle(): Promise<void> {
    const sid = this.state.meta.sessionId;
    if (!this.titleFromPrompt || !sid) return;
    const info = (await getSessionInfo(sid, { dir: this.state.info.cwd }).catch(() => undefined)) ?? (await getSessionInfo(sid).catch(() => undefined));
    const title = info?.customTitle || info?.summary;
    if (!title || !this.titleFromPrompt || title === info?.firstPrompt) return;
    this.titleFromPrompt = false;
    this.state.meta.title = title.length > 40 ? title.slice(0, 39) + '…' : title;
    this.patch('meta');
    this.onPersist?.();
    this.saveSessionTitle();
  }

  private agent(taskId: string): Agent | undefined {
    return this.state.agents.find((a) => a.id === taskId);
  }

  private onToolUse(id: string, name: string, input: Record<string, unknown>, parent: string | null): void {
    const s = this.state.stats;
    s.toolCalls++;
    const file = input.file_path ?? input.notebook_path;
    if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name) && typeof file === 'string' && !s.filesChanged.includes(file)) s.filesChanged.push(file);

    if (parent) {
      const a = this.agent(this.agentByToolUse.get(parent) ?? '');
      if (a && name === MISSION_TOOL) {
        // A subagent's plan goes on its own crew card; the hook keeps it off the main panel.
        const steps = Array.isArray(input.steps) ? (input.steps as { status?: string }[]) : [];
        const done = steps.filter((s) => s.status === 'completed').length;
        if (typeof input.title === 'string') a.summary = steps.length ? `${input.title} (${done}/${steps.length})` : input.title;
        this.patch('agents');
      } else if (a) {
        a.lastTool = name === 'SubagentHandback' ? friendlyTool(name) : `${name} ${describeTool(name, input, 60)}`;
        this.patch('agents');
      }
      return;
    }
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos as { content: string; status: Mission['steps'][number]['status']; activeForm?: string }[];
      const prev = this.state.mission;
      this.setMission({
        title: prev?.title ?? 'Current task',
        summary: prev?.summary ?? '',
        steps: todos.map((t) => ({ label: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content, status: t.status })),
        updatedAt: Date.now(),
      });
      return;
    }
    if (isMissionTool(name) || name === 'AskUserQuestion') return;
    const detail = describeTool(name, input);
    this.add({ id, kind: 'tool', name, detail, body: toolBody(name, input) });
    this.setActivity(`${name}: ${describeTool(name, input, 80)}`);
  }

  private canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const id = randomUUID();
      const title = opts.title ?? `Claude wants to use ${toolName}`;
      this.waiters.set(id, { resolve, input, title });
      opts.signal.addEventListener('abort', () => {
        if (!this.waiters.delete(id)) return;
        this.patchItem(id, { status: 'cancelled' });
        this.updateAttention();
        resolve({ behavior: 'deny', message: 'Cancelled.' });
      });
      if (toolName === 'AskUserQuestion') {
        this.add({ id, kind: 'ask', questions: (input.questions ?? []) as AskQuestion[], status: 'pending' });
        this.setActivity('Waiting for your answer');
      } else {
        this.add({ id, kind: 'perm', tool: toolName, title, detail: toolBody(toolName, input) ?? describeTool(toolName, input, 2000), status: 'pending' });
        this.setActivity(`Waiting for your OK: ${title}`);
      }
      this.updateAttention();
    });

  private setMission(mission: Mission): void {
    this.state.mission = mission;
    this.patch('mission');
  }

  private add(item: Item): void {
    this.state.items.push(item);
    this.emit({ t: 'item', tab: this.id, item });
  }

  private patchItem(id: string, fields: Record<string, unknown>): void {
    const item = this.state.items.find((i) => i.id === id);
    if (!item) return;
    Object.assign(item, fields);
    this.emit({ t: 'update', tab: this.id, item });
  }

  // The usage limit stopped work here: continue by itself just after the reset (or try again later when the
  // reset time is not known). Called again with a later reset time, it moves the plan.
  private limitHit(): void {
    if (process.env.PHOSPHOR_AUTO_CONTINUE === 'off') return;
    const now = Date.now();
    const at = this.limit.resetsAt && this.limit.resetsAt > now ? this.limit.resetsAt + RESUME_MARGIN_MS : now + RESUME_RETRY_MS;
    const prev = this.state.meta.resume;
    if (prev && Math.abs(prev.at - at) < 60_000) return;
    this.state.meta.resume = { at, limit: this.limit.type };
    this.patch('meta');
    this.onPersist?.();
    const when = new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    if (!prev) this.note(`Usage limit reached. AUTO-CONTINUE at ${when}.`);
  }

  clearResume(): void {
    if (!this.state.meta.resume) return;
    this.state.meta.resume = null;
    this.patch('meta');
    this.onPersist?.();
  }

  // Tabs calls this every 30 s. A chat that is already working again is left alone.
  resumeIfDue(now = Date.now()): void {
    const r = this.state.meta.resume;
    if (!r || now < r.at) return;
    this.clearResume();
    if (!this.state.meta.busy) this.send(AUTO_CONTINUE_TEXT, [], true);
  }

  resumeNow(): void {
    if (!this.state.meta.resume) return;
    this.clearResume();
    if (!this.state.meta.busy) this.send(AUTO_CONTINUE_TEXT, [], true);
  }

  private patch(key: PatchKey): void {
    this.emit({ t: 'patch', tab: this.id, key, value: this.state[key] } as ServerEvent);
    if (key === 'agents') this.onPersist?.(); // saved (debounced) so cards survive a restart
  }

  private note(text: string): void {
    this.add({ id: randomUUID(), kind: 'note', text });
  }

  private setActivity(text: string): void {
    if (this.state.activity === text) return;
    this.state.activity = text;
    this.patch('activity');
  }

  private updateAttention(): void {
    const attention = this.waiters.size > 0;
    if (this.state.meta.attention === attention) return;
    this.state.meta.attention = attention;
    this.patch('meta');
  }

  private setBusy(busy: boolean): void {
    if (this.state.meta.busy === busy) return;
    this.state.meta.busy = busy;
    if (busy) {
      this.state.stats.turnStartedAt = Date.now();
      this.patch('stats');
      this.setActivity('Thinking');
    } else {
      this.setActivity('');
    }
    this.patch('meta');
  }
}

function isInternalNote(text: string): boolean {
  return /report was delivered to you|SubagentHandback/i.test(text);
}

function friendlyTool(name: string): string {
  return name === 'SubagentHandback' ? 'Reporting back' : name;
}

function shortTitle(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 32 ? line.slice(0, 31) + '…' : line;
}

export function describeTool(name: string, input: unknown, max = 160): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
  let s = typeof pick === 'string' ? pick : JSON.stringify(i);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Longer text for the expandable tool line and permission card: full command or a simple diff.
function toolBody(name: string, input: Record<string, unknown>): string | undefined {
  const cap = (s: string) => (s.length > 6000 ? s.slice(0, 6000) + '\n…' : s);
  const lines = (s: unknown, prefix: string) => String(s ?? '').split('\n').map((l) => prefix + l).join('\n');
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') return cap(input.command);
  if (name === 'Edit') return cap(`${input.file_path}\n${lines(input.old_string, '- ')}\n${lines(input.new_string, '+ ')}`);
  if (name === 'Write') return cap(`${input.file_path}\n${lines(input.content, '+ ')}`);
  if (name === 'ExitPlanMode' && typeof input.plan === 'string') return input.plan.length > 40000 ? input.plan.slice(0, 40000) + '\n…' : input.plan;
  return undefined;
}

// Rebuild the chat, the last mission and rough stats (turns, tool calls, files changed) from a saved transcript.
const INLINE_MAX = 3.5 * 1024 * 1024; // the API takes images up to about 5 MB once base64 encoded

// The message Claude gets: images inline, then the text, then the saved path of every attachment.
function userContent(text: string, files: StoredUpload[]): SDKUserMessage['message']['content'] {
  if (!files.length) return text;
  const blocks: unknown[] = [];
  for (const f of files) {
    if (f.kind !== 'image' || f.size > INLINE_MAX) continue;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: readFileSync(f.path).toString('base64') } });
  }
  const list = files.map((f) => `- ${f.path}`).join('\n');
  blocks.push({ type: 'text', text: `${text}\n\n${ATTACH_HEADER}\n${list}`.trim() });
  return blocks as SDKUserMessage['message']['content'];
}

// Old chats: turn the attachment list back into chips (with thumbnails while the upload still exists).
function splitAttachments(text: string): { text: string; files: Attachment[] } {
  const at = text.indexOf(ATTACH_HEADER);
  if (at < 0) return { text, files: [] };
  const files: Attachment[] = [];
  for (const line of text.slice(at + ATTACH_HEADER.length).split('\n')) {
    const m = line.match(/^- (.+[\\/]uploads[\\/]([0-9a-f-]{36})[\\/]([^\\/]+))$/);
    if (!m) continue;
    const up = getUpload(m[2]);
    if (up) {
      const { path: _p, ...att } = up;
      files.push(att);
    } else {
      files.push({ id: '', name: m[3], kind: /\.(png|jpe?g|gif|webp)$/i.test(m[3]) ? 'image' : 'file', size: 0, mediaType: '' });
    }
  }
  return { text: text.slice(0, at).trim(), files };
}

// Transcript items with the saved image prompts and pictures put back after the message each followed.
export function mergeImages(items: Item[], log: SavedImage[]): Item[] {
  if (!log.length) return items;
  const byAnchor = new Map<string | null, Item[]>();
  const known = new Set(items.map((i) => i.id));
  for (const e of log) {
    const at = e.after === null || known.has(e.after) ? e.after : '\0end'; // its message is gone: at the end
    byAnchor.set(at, [...(byAnchor.get(at) ?? []), e.item]);
  }
  const out: Item[] = [...(byAnchor.get(null) ?? [])];
  let anchor: string | null = null;
  const flush = () => {
    if (anchor !== null) out.push(...(byAnchor.get(anchor) ?? []));
  };
  for (const i of items) {
    if (i.kind === 'user') {
      flush();
      anchor = i.id;
    }
    out.push(i);
  }
  flush();
  out.push(...(byAnchor.get('\0end') ?? []));
  return out;
}

function historyToItems(msgs: SessionMessage[]): { items: Item[]; mission: Mission | null; stats: Partial<Stats> } {
  const items: Item[] = [];
  let mission: Mission | null = null;
  const stats = { turns: 0, toolCalls: 0, filesChanged: [] as string[] };
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue;
    const msg = m.message as { content?: unknown; model?: string } | undefined;
    const content = msg?.content;
    const blocks: Record<string, unknown>[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const images: Attachment[] = []; // inline images with no saved copy listed (e.g. pasted in the terminal)
    let userItem: Extract<Item, { kind: 'user' }> | undefined;
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') {
        if (m.type === 'user') {
          const { text, files } = splitAttachments(cleanUserText(b.text));
          if (!text && !files.length) continue;
          stats.turns++;
          // The transcript uuid is the UNDO key, so old chats can undo too (if they had checkpoints).
          const id = m.uuid && !items.some((i) => i.id === m.uuid) ? m.uuid : randomUUID();
          userItem = { id, kind: 'user', text, ...(files.length ? { attachments: files } : {}), ...(text.startsWith('Auto-continue:') ? { auto: true } : {}) };
          items.push(userItem);
        } else {
          const text = b.text.trim();
          const who = speakerFor(msg?.model);
          if (text) items.push({ id: randomUUID(), kind: 'claude', text, ...(who ? { who } : {}) });
        }
      } else if (b.type === 'image' && m.type === 'user') {
        const src = (b.source ?? {}) as { media_type?: string };
        images.push({ id: '', name: 'image', kind: 'image', size: 0, mediaType: src.media_type ?? '' });
      } else if (b.type === 'tool_use' && m.type === 'assistant') {
        const name = String(b.name);
        const input = (b.input ?? {}) as Record<string, unknown>;
        stats.toolCalls++;
        const file = input.file_path ?? input.notebook_path;
        if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name) && typeof file === 'string' && !stats.filesChanged.includes(file)) stats.filesChanged.push(file);
        if (isMissionTool(name)) mission = { ...(input as Omit<Mission, 'updatedAt'>), updatedAt: 0 };
        else if (name !== 'AskUserQuestion' && name !== 'TodoWrite') items.push({ id: String(b.id), kind: 'tool', name, detail: describeTool(name, input), body: toolBody(name, input) });
      } else if (b.type === 'tool_result' && b.is_error) {
        const t = items.find((i) => i.id === b.tool_use_id);
        if (t?.kind === 'tool') t.error = true;
      }
    }
    if (images.length && !userItem?.attachments?.length) {
      if (userItem) userItem.attachments = images;
      else items.push({ id: randomUUID(), kind: 'user', text: '', attachments: images });
    }
  }
  return { items, mission, stats };
}
