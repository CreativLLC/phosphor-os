import { PROJECT_FILE_MAX, PROJECT_FILES_TOTAL, type ProjectFile, type ProjectFilesResponse } from '../../shared/protocol.ts';
import { store } from './store.ts';
import { button, confirmBox, el, timeAgo, toast } from './ui.ts';

// FILES (owner's ask 2026-10-28): reference files of a project (notes, PDFs, pictures, code), in its folder's files/
// (server/projectfiles.ts). Every chat of the project can read them and is told their names. Upload (button, or drop
// files on the box), open, download, delete. Opened from PROJECTS and the tab menu of a project chat.

const MB = 1024 * 1024;
export const fmtSize = (b: number) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/files`;

// Demo (?demo=1): a short list kept in this page.
const demoFiles: Record<string, ProjectFile[]> = {
  'demo-p': [
    { name: 'brand-colors.png', size: 182_000, updatedAt: Date.now() - 86_400_000 },
    { name: 'channel-notes.md', size: 4_200, updatedAt: Date.now() - 3_600_000 },
    { name: 'sponsor brief.pdf', size: 1_350_000, updatedAt: Date.now() - 2 * 86_400_000 },
  ],
};

export async function listFiles(id: string): Promise<ProjectFile[]> {
  if (store.demo) return [...(demoFiles[id] ?? [])];
  const r = (await (await fetch(base(id))).json()) as ProjectFilesResponse & { error?: string };
  if (r.error) throw new Error(r.error);
  return r.files ?? [];
}

// One upload; a name in use asks before replacing. Returns false when it failed or was skipped.
async function upload(id: string, file: File): Promise<boolean> {
  if (file.size > PROJECT_FILE_MAX) return toast(`${file.name}: over ${PROJECT_FILE_MAX / MB} MB.`), false;
  if (store.demo) {
    const files = (demoFiles[id] ??= []);
    demoFiles[id] = [...files.filter((f) => f.name !== file.name), { name: file.name, size: file.size, updatedAt: Date.now() }].sort((a, b) => a.name.localeCompare(b.name));
    return true;
  }
  const send = async (replace: boolean) => {
    const r = await fetch(`${base(id)}?name=${encodeURIComponent(file.name)}${replace ? '&replace=1' : ''}`, { method: 'POST', body: file });
    return { r, data: (await r.json().catch(() => ({}))) as { error?: string; exists?: boolean } };
  };
  try {
    let { r, data } = await send(false);
    if (r.status === 409 && data.exists) {
      if (!(await confirmBox('REPLACE FILE?', `${data.error} Replace it with the new one?`, 'REPLACE'))) return false;
      ({ r, data } = await send(true));
    }
    if (!r.ok) throw new Error(data.error ?? 'Upload failed.');
    return true;
  } catch (e) {
    toast(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`);
    return false;
  }
}

export async function editFiles(p: { id: string; name: string }, onClose?: () => void): Promise<void> {
  const d = el('dialog', 'proj-edit proj-files');
  const rows = el('div', 'pf-list');
  const total = el('span', 'proj-edit-size');
  const status = el('div', 'pf-status');
  status.hidden = true;
  const pick = el('input');
  pick.type = 'file';
  pick.multiple = true;
  pick.hidden = true;

  const render = (files: ProjectFile[]) => {
    const used = files.reduce((n, f) => n + f.size, 0);
    total.textContent = `${files.length} FILE${files.length === 1 ? '' : 'S'} · ${fmtSize(used)} / ${PROJECT_FILES_TOTAL / MB} MB`;
    rows.replaceChildren(
      ...files.map((f) => {
        const row = el('div', 'pf-row');
        const href = `${base(p.id)}/${encodeURIComponent(f.name)}`;
        const open = el('a', 'pf-name', f.name);
        open.href = href;
        open.target = '_blank';
        open.rel = 'noopener';
        open.title = 'Open in a new tab (pictures, PDFs and text; other files download)';
        const save = el('a', 'pf-btn', 'DOWNLOAD');
        save.href = `${href}?download=1`;
        save.download = f.name;
        const del = button('DELETE', () => void remove(f), 'pf-delete');
        row.append(open, el('span', 'pf-meta', `${fmtSize(f.size)} · ${timeAgo(f.updatedAt)}`), save, del);
        return row;
      }),
    );
    if (!files.length) rows.append(el('div', 'empty', 'No files yet. UPLOAD adds some (or drop them here).'));
  };
  const reload = async () => {
    try {
      render(await listFiles(p.id));
    } catch (e) {
      rows.replaceChildren(el('div', 'empty', `Could not load the files${e instanceof Error && e.message ? `: ${e.message}` : '.'}`));
    }
  };
  const remove = async (f: ProjectFile) => {
    if (!(await confirmBox(`DELETE ${f.name.toUpperCase()}?`, "It goes from the project's files. The chats can no longer read it.", 'DELETE'))) return;
    if (store.demo) demoFiles[p.id] = (demoFiles[p.id] ?? []).filter((x) => x.name !== f.name);
    else {
      const r = await fetch(`${base(p.id)}/${encodeURIComponent(f.name)}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
      if (!r?.ok) toast('Not deleted.');
    }
    await reload();
  };
  const add = async (files: File[]) => {
    let done = 0;
    for (const f of files) {
      status.textContent = `UPLOADING ${f.name.toUpperCase()}${files.length > 1 ? ` (${done + 1}/${files.length})` : ''}…`;
      status.hidden = false;
      if (await upload(p.id, f)) done++;
      await reload();
    }
    status.hidden = true;
    if (done) toast(`${done} file${done === 1 ? '' : 's'} added. The chats are told from their next message.`);
  };
  pick.onchange = () => {
    const files = [...(pick.files ?? [])];
    pick.value = '';
    if (files.length) void add(files);
  };
  // Drop files anywhere on the box (desktop).
  d.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    d.classList.add('pf-drop');
  });
  d.addEventListener('dragleave', (e) => {
    if (e.target === d) d.classList.remove('pf-drop');
  });
  d.addEventListener('drop', (e) => {
    d.classList.remove('pf-drop');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void add(files);
  });

  const close = () => {
    d.close();
    d.remove();
    onClose?.();
  };
  const help = el('p', 'proj-edit-help', `Reference files for this project: notes, PDFs, pictures, code. Every chat in it can read them. Up to ${PROJECT_FILE_MAX / MB} MB a file.`);
  const foot = el('div', 'buttons');
  foot.append(total, button('UPLOAD', () => pick.click(), 'primary'), button('CLOSE', close));
  d.append(el('h2', '', `FILES: ${p.name.toUpperCase()}`), help, status, rows, pick, foot);
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  rows.append(el('div', 'empty', 'Loading…'));
  document.body.append(d);
  d.showModal();
  await reload();
}
