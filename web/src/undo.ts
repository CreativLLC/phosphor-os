import type { ServerEvent } from '../../shared/protocol.ts';
import { send } from './net.ts';
import { store } from './store.ts';
import { button, el, shortPath, toast } from './ui.ts';

// UNDO on a message you sent: preview which files Claude changed since then, confirm, put them back.

type UndoResult = Extract<ServerEvent, { t: 'undo_result' }>;

let dialog: HTMLDialogElement;
let waiting: { tab: string; id: string; label: string; files: string[]; timer: number } | undefined;

export function mountUndo(d: HTMLDialogElement): void {
  dialog = d;
  store.on((c) => {
    if (c.kind === 'undo') onResult(c.result);
  });
}

export function askUndo(tab: string, id: string, label: string): void {
  if (store.demo) return toast('Demo mode: undo needs the real server.');
  if (store.tabs.get(tab)?.meta.busy) return toast('Claude is still working. Wait until it is done, or press STOP.');
  clearTimeout(waiting?.timer);
  const timer = window.setTimeout(() => toast('No answer from the server. If it just updated, reload the page.'), 8000);
  waiting = { tab, id, label, files: [], timer };
  send({ t: 'undo', tab, id, dryRun: true });
}

function onResult(r: UndoResult): void {
  if (!waiting || waiting.id !== r.id) return;
  clearTimeout(waiting.timer);
  if (!r.ok) {
    toast(`Undo: ${r.error ?? 'not possible'}`);
    waiting = undefined;
    return;
  }
  if (!r.dryRun) {
    const n = waiting.files.length;
    toast(`Undone. ${n} file${n === 1 ? '' : 's'} put back.`);
    waiting = undefined;
    return;
  }
  if (r.files.length === 0) {
    toast('Nothing to undo: Claude changed no files after that message.');
    waiting = undefined;
    return;
  }
  waiting.files = r.files;
  const cwd = store.tabs.get(r.tab)?.info.cwd ?? '';
  const list = el('ul', 'undo-files');
  for (const f of r.files) list.append(el('li', '', shortPath(f, cwd)));
  const go = button('UNDO', () => {
    dialog.close();
    if (!waiting) return;
    waiting.timer = window.setTimeout(() => toast('No answer from the server.'), 15000);
    send({ t: 'undo', tab: r.tab, id: r.id, dryRun: false });
  }, 'primary');
  const cancel = button('CANCEL', () => {
    dialog.close();
    waiting = undefined;
  });
  const row = el('div', 'buttons');
  row.append(go, cancel);
  dialog.replaceChildren(
    el('h2', '', "UNDO CLAUDE'S FILE CHANGES?"),
    el('p', 'undo-what', `These files go back to how they were before your message "${waiting.label}":`),
    list,
    el('p', 'undo-stats', `+${r.insertions} / -${r.deletions} lines. The chat itself stays; Claude is told about the undo.`),
    row,
  );
  dialog.showModal();
}
