import { listSessions, query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EFFORTS, IMAGE_MODEL, LEAD_PREFIX, isImageModel, LOCAL_MODEL, type Effort, type FoldersResponse, type HistoryEntry, type HistoryResponse, type HistorySearchResponse, type ModelsResponse, type ServerEvent, type TabState } from '../shared/protocol.ts';
import { DATA_DIR, config, geminiImage, imageModel, localChoice, localModel } from './config.ts';
import { geminiModels } from './geminitab.ts';
import { projectDir, projectMemory, Tab, type TabInit } from './tab.ts';
import { APP_ENTRYPOINT, entrypointOf, matchAt, queryWords, snippet, textOf, transcriptPaths } from './transcripts.ts';

const SHOWN_MODELS = ['opus', 'sonnet', 'haiku'];

const TABS_FILE = join(DATA_DIR, 'tabs.json');

// All open chat tabs. Saved to data/tabs.json so tabs come back after a restart.
export class Tabs {
  private tabs = new Map<string, Tab>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private modelList?: Promise<ModelsResponse>;
  private modelsLoaded?: ModelsResponse;

  constructor(private emit: (ev: ServerEvent) => void) {
    Tab.models = () => this.models();
    Tab.knownModels = () => this.modelsLoaded;
    Tab.projects = { thread: (lead, title, brief) => this.thread(lead, title, brief), members: (id) => [...this.tabs.values()].filter((t) => t.project?.id === id) };
    // AUTO-CONTINUE: a chat stopped by the usage limit goes on once the limit resets (Tab.resumeIfDue).
    // A short interval, not one long timer: survives sleep, and the time can move.
    setInterval(() => {
      for (const t of this.tabs.values()) t.resumeIfDue();
    }, 30_000).unref();
  }

  async restore(): Promise<void> {
    let saved: TabInit[] = [];
    try {
      if (existsSync(TABS_FILE)) saved = JSON.parse(readFileSync(TABS_FILE, 'utf8'));
    } catch {
      saved = [];
    }
    for (const init of saved) {
      // The local model is gone (not configured now): Claude would be handed the name "local" and fail.
      const missingLocal =
        !!init.model && (((init.model === LOCAL_MODEL || init.model.startsWith(`${LOCAL_MODEL}:`)) && !localChoice(init.model)) || (init.model === IMAGE_MODEL && !imageModel) || (isImageModel(init.model) && init.model !== IMAGE_MODEL && !Tab.gemini.has(init.model)));
      const tab = this.make(missingLocal ? { ...init, model: undefined, effort: undefined, auto: true } : init);
      await tab.loadHistory().catch((e) => console.warn(`Could not load history for tab ${init.title}:`, e));
    }
    if (this.tabs.size === 0) this.make({ cwd: config.cwd, auto: true });
    await Promise.all([...this.tabs.values()].map((t) => t.prefillInfo()));
    for (const t of this.tabs.values()) void t.syncSessionTitle();
    this.save();
  }

  get(id: string): Tab | undefined {
    return this.tabs.get(id);
  }

  list(): TabState[] {
    return [...this.tabs.values()].map((t) => t.state);
  }

  // A Claude process that is already running in any tab, for account questions (usage meter).
  liveQuery(): Query | undefined {
    for (const t of this.tabs.values()) if (t.query) return t.query;
    return undefined;
  }

  create(cwd: string | undefined, req?: string): void {
    const tab = this.make({ cwd: cwd && this.allowedFolder(cwd) ? cwd : config.cwd, auto: true });
    this.save();
    this.emit({ t: 'tab', tab: tab.state, req });
    void tab.prefillInfo();
  }

  // A new project: its lead chat in the workspace folder, and its shared memory file.
  createProject(name: string, req?: string): void {
    const id = randomUUID().slice(0, 8);
    mkdirSync(projectDir(id), { recursive: true });
    writeFileSync(projectMemory(id), `# ${name}\n\nShared memory of this Phosphor-OS project: the lead chat and every thread read it and keep it current.\n\n## Goal\n\n## Decisions\n\n## Threads\n\n## Open questions\n`);
    const tab = this.make({ cwd: config.cwd, title: name, auto: true, project: { id, name, main: true } });
    this.save();
    this.emit({ t: 'tab', tab: tab.state, req });
    void tab.prefillInfo();
  }

  // A thread for a project's lead: the lead's folder and model settings; it starts on the brief at once.
  private thread(lead: Tab, title: string, brief: string): Tab {
    const p = lead.project!;
    const tab = this.make({ cwd: lead.state.info.cwd, title: title.trim().slice(0, 60) || 'Thread', mode: lead.mode, model: lead.model, effort: lead.effort, auto: lead.autoModel, project: { id: p.id, name: p.name, main: false, parent: lead.id } });
    this.save();
    this.emit({ t: 'tab', tab: tab.state });
    void tab.prefillInfo();
    tab.send(`${LEAD_PREFIX}${brief}`);
    return tab;
  }

  async open(sessionId: string, cwd: string, title: string, req?: string): Promise<void> {
    const existing = [...this.tabs.values()].find((t) => t.state.meta.sessionId === sessionId);
    if (existing) {
      this.emit({ t: 'tab', tab: existing.state, req });
      return;
    }
    // Always the workspace folder (PHOSPHOR_CWD), so Claude keeps the workspace's CLAUDE.md and memory.
    // `cwd` is where the chat last ran a command, often a project subfolder; resuming by id works from here.
    void cwd;
    const tab = this.make({ cwd: config.cwd, title: title.slice(0, 60) || 'Old chat', sessionId, auto: true });
    try {
      await tab.loadHistory();
    } catch (e) {
      this.emit({ t: 'toast', text: `Could not read that chat: ${e instanceof Error ? e.message : e}` });
    }
    void tab.syncSessionTitle();
    this.save();
    this.emit({ t: 'tab', tab: tab.state, req });
    void tab.prefillInfo();
  }

  close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.close();
    this.tabs.delete(id);
    this.save();
    this.emit({ t: 'tab_closed', tab: id });
  }

  async history(all = false): Promise<HistoryResponse> {
    return { sessions: (await this.historyList(all)).map(({ path: _p, ...s }) => s) };
  }

  // Chats whose own text has every word, newest first, each with a short piece of text around the first hit.
  async searchHistory(q: string, all = false): Promise<HistorySearchResponse> {
    const words = queryWords(q);
    const hits: HistorySearchResponse['hits'] = [];
    if (!words.length) return { hits };
    // One file at a time: a first search reads every chat, some are tens of MB.
    for (const s of await this.historyList(all)) {
      const text = s.path ? await textOf(s.path).catch(() => '') : '';
      const at = matchAt(text, words);
      if (at >= 0) hits.push({ sessionId: s.sessionId, snippet: snippet(text, at) });
    }
    return { hits };
  }

  // HISTORY lists Phosphor-OS chats: started in this app, or open in a tab now. With `all`, every Claude Code
  // chat on this PC (terminal, VS Code, desktop app). An open tab's name wins: the session file may lag behind.
  // 500: enough that this app's chats still fill the list once the others are left out.
  private async historyList(all: boolean): Promise<(HistoryEntry & { path?: string })[]> {
    const open = new Map([...this.tabs.values()].map((t) => [t.state.meta.sessionId, t]));
    const paths = transcriptPaths();
    const sessions = await listSessions({ limit: 500 });
    const rows = await Promise.all(
      sessions
        .filter((s) => s.cwd)
        .map(async (s) => {
          const tab = open.get(s.sessionId);
          const path = paths.get(s.sessionId);
          if (!all && !tab && !(path && (await entrypointOf(path)) === APP_ENTRYPOINT)) return null;
          return {
            sessionId: s.sessionId,
            title: tab?.state.meta.title ?? (s.customTitle || s.summary || s.firstPrompt || '(untitled)'),
            cwd: s.cwd!,
            lastModified: s.lastModified,
            openTab: tab?.id,
            path,
          };
        }),
    );
    return rows.filter((r) => r !== null);
  }

  // Models this account can use. Asked once from a short-lived Claude process (no prompt is sent).
  models(): Promise<ModelsResponse> {
    this.modelList ??= (async () => {
      const idle = (async function* (): AsyncGenerator<never> {
        await new Promise(() => {});
      })();
      const q = query({ prompt: idle, options: { cwd: config.cwd, persistSession: false } }); // leaves no chat in HISTORY
      const gemini = geminiModels(); // Gemini chats through agy (server/geminitab.ts), asked at the same time
      try {
        const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('model list timed out')), 30000));
        const list = await Promise.race([q.supportedModels(), timeout]);
        return {
          // Only the current three (AUTO picks among them; "default" is gone, AUTO is the default). Older ones
          // are left out on purpose; add a value here to bring one back.
          models: [...list.filter((m) => SHOWN_MODELS.includes(m.value)).map((m) => ({
            value: m.value,
            label: m.displayName,
            description: m.description,
            resolved: m.resolvedModel,
            efforts: m.supportsEffort === false ? [] : (m.supportedEffortLevels ?? [...EFFORTS]),
          })), ...(localModel?.models ?? []).map((m) => ({ value: m.value, label: m.label, description: 'Runs on this PC, no plan limits.', efforts: ['low', 'medium', 'xhigh'] as Effort[] })),
            ...(await gemini),
            ...(imageModel ? [{ value: IMAGE_MODEL, label: imageModel.label, description: 'Makes pictures on this PC. Your message is the picture\'s description.', efforts: [] as Effort[] }] : []),
            ...geminiImage.models.map((m) => ({ value: m.value, label: m.label, description: 'Makes pictures with Gemini (your Google AI Pro sign-in). Your message is the picture\'s description.', efforts: [] as Effort[] }))],
        };
      } finally {
        q.close();
      }
    })();
    this.modelList.then((l) => (this.modelsLoaded = l), () => (this.modelList = undefined)); // failed: retry next time
    return this.modelList;
  }

  folders(): FoldersResponse {
    const root = config.cwd;
    const folders = [{ name: basename(root), path: root }];
    const projects = join(root, 'projects');
    if (existsSync(projects)) {
      for (const d of readdirSync(projects, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.')) folders.push({ name: `projects/${d.name}`, path: join(projects, d.name) });
      }
    }
    return { root, folders };
  }

  private allowedFolder(cwd: string): boolean {
    return this.folders().folders.some((f) => f.path === cwd);
  }

  private make(init: TabInit): Tab {
    const tab = new Tab(this.emit, init);
    tab.onPersist = () => this.saveSoon();
    this.tabs.set(tab.id, tab);
    return tab;
  }

  // Agent progress changes often; write tabs.json at most once a second for those.
  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  private save(): void {
    const data: TabInit[] = [...this.tabs.values()].map((t) => ({
      id: t.id,
      cwd: t.state.info.cwd,
      title: t.state.meta.title,
      sessionId: t.state.meta.sessionId,
      createdAt: t.state.meta.createdAt,
      mode: t.mode,
      model: t.model,
      effort: t.effort,
      auto: t.autoModel || undefined,
      agents: t.state.agents.slice(-30),
      resume: t.state.meta.resume ?? undefined,
      images: t.images.length ? t.images : undefined,
      project: t.project,
      gemini: t.geminiId,
    }));
    writeFileSync(TABS_FILE, JSON.stringify(data, null, 2));
  }
}
