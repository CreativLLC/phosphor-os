import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { INSTRUCTIONS_MAX, MEMORY_MAX, type ProjectDoc, type ProjectDocKind, type ProjectRef, type ProjectSummary, type TabState } from '../shared/protocol.ts';
import { DATA_DIR } from './config.ts';

// PROJECTS (owner's ask 2026-10-27): a project outlives its tabs. data/projects/<id>/project.json keeps its name and
// the chats closed since, so the PROJECTS list shows every project and reopens its chats through the HISTORY resume
// path (Tabs.open). Projects made before this file have only PROJECT.md: the name comes from its title line.

const DOC_MAX: Record<ProjectDocKind, number> = { instructions: INSTRUCTIONS_MAX, memory: MEMORY_MAX };
const hash = (text: string) => (text ? createHash('sha1').update(text).digest('hex').slice(0, 16) : '');

export type ClosedChat = { sessionId: string; title: string; main: boolean; own?: boolean; createdAt: number; closedAt: number };
type ProjectFile = { name: string; createdAt: number; closed: ClosedChat[] };

export class ProjectBook {
  constructor(readonly root = join(DATA_DIR, 'projects')) {}

  // A new project (its folder and PROJECT.md are made by Tabs.createProject).
  create(id: string, name: string): void {
    this.write(id, { name, createdAt: Date.now(), closed: [] });
  }

  read(id: string): ProjectFile | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined; // ids come from the page too
    const dir = join(this.root, id);
    try {
      const f = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as ProjectFile;
      return { name: String(f.name), createdAt: Number(f.createdAt) || 0, closed: Array.isArray(f.closed) ? f.closed : [] };
    } catch {
      /* none yet: an older project */
    }
    try {
      const name = /^#\s+(.+)/.exec(readFileSync(join(dir, 'PROJECT.md'), 'utf8'))?.[1]?.trim();
      return name ? { name, createdAt: statSync(dir).mtimeMs, closed: [] } : undefined;
    } catch {
      return undefined;
    }
  }

  // A project chat was closed: kept so PROJECTS (or HISTORY) can bring it back into the project.
  noteClosed(p: ProjectRef, chat: Omit<ClosedChat, 'closedAt'>): void {
    const f = this.read(p.id) ?? { name: p.name, createdAt: chat.createdAt, closed: [] };
    f.closed = [...f.closed.filter((c) => c.sessionId !== chat.sessionId), { ...chat, closedAt: Date.now() }];
    this.write(p.id, f);
  }

  // A closed chat being reopened: taken off its project's closed list, with the project it belongs to.
  take(sessionId: string): { id: string; name: string; chat: ClosedChat } | undefined {
    for (const id of this.ids()) {
      const f = this.read(id);
      const chat = f?.closed.find((c) => c.sessionId === sessionId);
      if (!f || !chat) continue;
      this.write(id, { ...f, closed: f.closed.filter((c) => c !== chat) });
      return { id, name: f.name, chat };
    }
    return undefined;
  }

  // Every project, open or not, the newest activity first. lastActive: when a saved chat last changed, if known.
  list(open: TabState[], lastActive: (sessionId: string) => number | undefined): ProjectSummary[] {
    const ids = new Set([...this.ids(), ...open.flatMap((t) => (t.meta.project ? [t.meta.project.id] : []))]);
    const out: ProjectSummary[] = [];
    for (const id of ids) {
      const tabs = open.filter((t) => t.meta.project?.id === id);
      const f = this.read(id);
      const name = f?.name ?? tabs[0]?.meta.project?.name;
      if (!name) continue;
      const closed = f?.closed ?? [];
      const times = [
        f?.createdAt ?? 0,
        ...tabs.map((t) => (t.meta.sessionId && lastActive(t.meta.sessionId)) || t.meta.createdAt),
        ...closed.map((c) => Math.max(c.closedAt, lastActive(c.sessionId) ?? 0)),
      ];
      out.push({ id, name, createdAt: f?.createdAt ?? Math.min(...tabs.map((t) => t.meta.createdAt)), lastActive: Math.max(...times), closed: closed.map(({ sessionId, title, main }) => ({ sessionId, title, main })) });
    }
    return out.sort((a, b) => b.lastActive - a.lastActive);
  }

  // The order PROJECTS reopens closed chats in: the lead first (threads find it), then the oldest first.
  static reopenOrder(closed: ClosedChat[]): ClosedChat[] {
    return [...closed].sort((a, b) => Number(b.main) - Number(a.main) || a.createdAt - b.createdAt);
  }

  // DELETE in PROJECTS: the project's folder (memory file, closed-chat list) moves to data/projects-deleted/, so a
  // slip can be undone by moving it back. Its chats stay in HISTORY as plain chats.
  remove(id: string): boolean {
    if (!/^[\w-]+$/.test(id) || !existsSync(join(this.root, id))) return false;
    const bin = join(this.root, '..', 'projects-deleted');
    mkdirSync(bin, { recursive: true });
    renameSync(join(this.root, id), join(bin, `${id}-${Date.now()}`));
    return true;
  }

  // INSTRUCTIONS (owner's ask 2026-10-28): the user's own rules for the project, like a CLAUDE.md for it. Every chat
  // of the project gets them in its system prompt (Tab.start). Empty text removes the file.
  // MEMORY: PROJECT.md, the shared memory the chats read and write; the user views and edits it too.
  // base: the version the editor loaded; a save over a newer version (a chat wrote it since) is refused.
  instructions(id: string): ProjectDoc {
    return this.doc(id, 'instructions') ?? { text: '', updatedAt: 0, version: '' };
  }

  doc(id: string, kind: ProjectDocKind): ProjectDoc | undefined {
    const file = this.docFile(id, kind);
    if (!file) return undefined;
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (!st?.isFile()) return { text: '', updatedAt: 0, version: '' }; // none yet (a link is not followed)
    if (st.size > DOC_MAX[kind] * 2) return undefined; // grown far past what the editor takes
    const text = readFileSync(file, 'utf8');
    return { text, updatedAt: st.mtimeMs, version: hash(text) };
  }

  setDoc(id: string, kind: ProjectDocKind, text: string, base?: string): { ok: true; updatedAt: number; version: string } | { error: string; changed?: ProjectDoc } {
    const file = this.docFile(id, kind);
    if (!file || !existsSync(join(this.root, id))) return { error: 'No such project.' };
    if (lstatSync(file, { throwIfNoEntry: false })?.isFile() === false) return { error: `${basename(file)} is not a plain file.` }; // a link put there
    text = text.replace(/\r\n/g, '\n');
    if (kind === 'instructions') text = text.trim();
    if (Buffer.byteLength(text) > DOC_MAX[kind]) return { error: `Too long: at most ${DOC_MAX[kind] / 1000} KB.` };
    if (kind === 'instructions' && text) text += '\n';
    const now = this.doc(id, kind);
    if (base !== undefined && now && now.version !== base) return { error: 'The file changed since you opened it.', changed: now };
    if (text || kind === 'memory') writeFileSync(file, text);
    else rmSync(file, { force: true });
    return { ok: true, updatedAt: text || kind === 'memory' ? statSync(file).mtimeMs : Date.now(), version: hash(text) };
  }

  // The project's folder, for its files (server/projectfiles.ts); undefined for an id with a path in it.
  dir(id: string): string | undefined {
    return /^[\w-]+$/.test(id) ? join(this.root, id) : undefined;
  }

  private docFile(id: string, kind: ProjectDocKind): string | undefined {
    return /^[\w-]+$/.test(id) ? join(this.root, id, kind === 'instructions' ? 'INSTRUCTIONS.md' : 'PROJECT.md') : undefined;
  }

  private ids(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  }

  private write(id: string, f: ProjectFile): void {
    mkdirSync(join(this.root, id), { recursive: true });
    writeFileSync(join(this.root, id, 'project.json'), JSON.stringify(f, null, 2));
  }
}

// The project ref of a chat joining a project: + CHAT (own), or a closed chat coming back. lead: the project's open
// lead tab, if any. Only one lead: a lead coming back while another is open joins as a thread.
export function joinRef(id: string, name: string, lead: { id: string } | undefined, want: { main: boolean; own?: boolean }): ProjectRef {
  if (want.main && !lead) return { id, name, main: true };
  return { id, name, main: false, ...(lead ? { parent: lead.id } : {}), ...(want.own ? { own: true } : {}) };
}
