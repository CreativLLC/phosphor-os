import { IMAGE_MODEL, isImageModel, MODES, type Attachment, type ImageItem, type Item, type Mode } from '../../shared/protocol.ts';
import { takeAttachments } from './attach.ts';
import { runAppCommand } from './slash.ts';
import { askUndo } from './undo.ts';
import { isDictating, stopDictation } from './voice.ts';
import { setMarkdown } from './md.ts';
import { send } from './net.ts';
import { store, watchActive } from './store.ts';
import { shellApi } from './shellapi.ts';
import { button, el, toast } from './ui.ts';
import { whenFull, whenText } from './when.ts';

const MODE_LABELS: Record<string, string> = {
  default: 'ASK FIRST',
  acceptEdits: 'AUTO-EDIT',
  plan: 'PLAN ONLY',
  auto: 'AUTO',
  bypassPermissions: 'BYPASS',
};
// BYPASS = no permission prompts at all (hooks such as the prod-write block still run).
const PICKER_MODES = [...new Set<string>([...MODES, 'bypassPermissions'])];

let log: HTMLElement;
let input: HTMLTextAreaElement;
const drafts = new Map<string, string>(); // unsent text per tab

// The log follows new content while you are at the bottom ("pinned"). Scrolling up to read unpins it
// and shows a jump button; reaching the bottom again, sending, or switching tabs pins it again.
let pinned = true;
let lastTop = 0;
let jump: HTMLButtonElement;

// Put text into the message box (used by the file explorer's "insert path" button).
export function insertIntoChat(text: string): void {
  const before = input.value && !input.value.endsWith(' ') ? input.value + ' ' : input.value;
  input.value = before + text + ' ';
  input.focus();
  autoGrow();
}

export function mountChat(logEl: HTMLElement, composer: HTMLElement): void {
  log = logEl;
  input = composer.querySelector('#input') as HTMLTextAreaElement;
  // The '>' prompt mark (theme.css) follows the message box down when the attachment tray or the live dictation
  // line appears above it.
  const markTop = () => composer.style.setProperty('--input-top', `${input.offsetTop}px`);
  new ResizeObserver(markTop).observe(composer);
  markTop();
  const sendBtn = composer.querySelector('#send') as HTMLButtonElement;
  const stopBtn = composer.querySelector('#stop') as HTMLButtonElement;
  const mode = composer.querySelector('#mode') as HTMLSelectElement;

  for (const m of PICKER_MODES) mode.append(new Option(MODE_LABELS[m] ?? m.toUpperCase(), m));
  mode.title = 'Permission mode: when Claude must ask you first. BYPASS never asks.';
  mode.onchange = () => {
    mode.classList.toggle('bypass', mode.value === 'bypassPermissions');
    if (store.active) send({ t: 'mode', tab: store.active, mode: mode.value as Mode });
  };

  const submit = async () => {
    if (!store.active) return;
    // Sending ends dictation; its last words go into this message.
    if (isDictating()) {
      sendBtn.disabled = true;
      await stopDictation();
      sendBtn.disabled = false;
      if (!store.active) return;
    }
    const text = input.value.trim();
    if (runAppCommand(text)) {
      input.value = '';
      drafts.delete(store.active);
      autoGrow();
      return;
    }
    const ids = takeAttachments(store.active);
    if (ids === null || (!text && !ids.length)) return;
    send({ t: 'send', tab: store.active, text, ...(ids.length ? { attachments: ids } : {}) });
    input.value = '';
    drafts.delete(store.active);
    autoGrow();
    pinned = true;
    stick();
  };
  sendBtn.onclick = () => void submit();
  stopBtn.onclick = () => store.active && send({ t: 'stop', tab: store.active });
  input.addEventListener('keydown', (e) => {
    // On a phone keyboard, Enter makes a new line; the SEND button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      void submit();
    }
  });
  input.addEventListener('input', () => {
    if (store.active) drafts.set(store.active, input.value);
    autoGrow();
  });

  let shownTab: string | null = null;
  watchActive(['meta', 'info'], (tab) => {
    stopBtn.hidden = !tab?.meta.busy;
    composer.classList.toggle('busy', !!tab?.meta.busy);
    mode.value = PICKER_MODES.includes(tab?.info.permissionMode ?? '') ? tab!.info.permissionMode : 'auto';
    const model = tab?.info.auto ? '' : tab?.info.model;
    input.placeholder = model === IMAGE_MODEL ? 'Describe a picture… (--wide --tall --best --seed N)' : isImageModel(model) ? 'Describe a picture, or attach one to change… (--wide --tall)' : 'Message Claude…';
    mode.classList.toggle('bypass', mode.value === 'bypassPermissions');
    if (tab?.meta.id !== shownTab) {
      shownTab = tab?.meta.id ?? null;
      input.value = (shownTab && drafts.get(shownTab)) || '';
      autoGrow();
    }
  });

  jump = button('▼ LATEST', () => {
    pinned = true;
    stick();
  }, 'jump-latest');
  jump.hidden = true;
  log.parentElement!.append(jump);
  log.addEventListener(
    'scroll',
    () => {
      const gap = log.scrollHeight - log.scrollTop - log.clientHeight;
      if (gap < 40) pinned = true;
      else if (log.scrollTop < lastTop - 4) pinned = false; // moved up: the reader is in charge
      lastTop = log.scrollTop;
      jump.hidden = pinned;
    },
    { passive: true },
  );
  // The log gets shorter or taller (message box grows, progress bar changes, window resizes).
  new ResizeObserver(() => stick()).observe(log);
  // Thumbnails load after they are placed and push the content down.
  log.addEventListener('load', () => stick(), true);

  watchActive([], renderAll);
  store.on((c) => {
    if (c.kind === 'item' && c.tab === store.active) {
      const node = render(c.item);
      const old = document.getElementById(domId(c.item.id));
      if (c.op === 'update' && old) {
        old.replaceWith(node);
        const g = node.closest<HTMLElement>('.tool-group');
        if (g) updateGroup(g);
      } else if (c.item.kind === 'tool') {
        let g = log.lastElementChild as HTMLElement | null;
        if (!g?.classList.contains('tool-group')) {
          g = makeGroup(c.item.id);
          log.append(g);
        }
        groupList(g).append(node);
        updateGroup(g);
      } else {
        log.append(node);
      }
      stick();
    } else if (c.kind === 'delta' && c.tab === store.active) {
      scheduleMarkdown(c.id);
    }
  });
}

function renderAll(): void {
  const tab = store.current();
  if (!tab) {
    log.replaceChildren(el('div', 'empty', 'No chat open. Press + to start one.'));
    return;
  }
  // Runs of tool lines go into one folded group.
  const nodes: HTMLElement[] = [];
  let group: HTMLElement | null = null;
  for (const item of tab.items) {
    if (item.kind !== 'tool') {
      group = null;
      nodes.push(render(item));
      continue;
    }
    if (!group) {
      group = makeGroup(item.id);
      nodes.push(group);
    }
    groupList(group).append(render(item));
  }
  for (const n of nodes) if (n.classList.contains('tool-group')) updateGroup(n);
  log.replaceChildren(...nodes);
  if (tab.items.length === 0) log.append(el('div', 'empty', `READY. Working in ${tab.info.cwd}`));
  pinned = true;
  stick();
}

// ---- Tool groups: one quiet line ("3 STEPS: READ x2 · BASH ...  last detail"); tap to see each step. ----

const openGroups = new Set<string>(); // keyed by the group's first tool id, so a redraw keeps it open

function makeGroup(key: string): HTMLElement {
  const g = el('div', 'tool-group');
  const sum = el('button', 'tg-sum');
  sum.type = 'button';
  sum.onclick = () => {
    if (g.classList.toggle('open')) openGroups.add(key);
    else openGroups.delete(key);
  };
  g.classList.toggle('open', openGroups.has(key));
  g.append(sum, el('div', 'tg-list'));
  return g;
}

const groupList = (g: HTMLElement) => g.querySelector(':scope > .tg-list') as HTMLElement;

function updateGroup(g: HTMLElement): void {
  const tools = [...groupList(g).children] as HTMLElement[];
  const counts = new Map<string, number>();
  for (const t of tools) {
    const raw = t.querySelector('.name')?.textContent ?? '?';
    const name = raw.includes('__') ? raw.slice(raw.lastIndexOf('__') + 2) : raw; // mcp__server__tool -> tool
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([n, k]) => (k > 1 ? `${n} x${k}` : n)).join(' · ');
  const failed = tools.filter((t) => t.classList.contains('error')).length;
  const last = tools.at(-1)?.querySelector('.detail')?.textContent?.trim() ?? '';
  const sum = g.querySelector('.tg-sum') as HTMLElement;
  sum.textContent = `${tools.length} ${tools.length === 1 ? 'STEP' : 'STEPS'}: ${names.toUpperCase()}${failed ? ` · ${failed} FAILED` : ''}${last ? `   ${last}` : ''}`;
  sum.title = 'Show each step';
}

// Re-render streaming markdown about 12 times a second. Every frame was too slow on long replies:
// the whole reply is parsed and sanitized each time.
const STREAM_MS = 80;
const pending = new Set<string>();
function scheduleMarkdown(id: string): void {
  if (pending.has(id)) return;
  pending.add(id);
  setTimeout(() => {
    pending.delete(id);
    const item = store.current()?.items.find((i) => i.id === id);
    const body = document.getElementById(domId(id))?.querySelector('.body');
    if (item?.kind === 'claude' && body) setMarkdown(body as HTMLElement, item.text);
    stick();
  }, STREAM_MS);
}

// Keep the newest line in view while pinned. Off-screen items get their real height only once drawn
// (content-visibility), so settle again over the next two frames.
function stick(): void {
  if (!pinned) {
    if (jump) jump.hidden = false;
    return;
  }
  const go = () => {
    if (!pinned) return;
    log.scrollTop = log.scrollHeight;
    lastTop = log.scrollTop;
  };
  go();
  requestAnimationFrame(() => {
    go();
    requestAnimationFrame(go);
  });
}

function autoGrow(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}

const domId = (id: string) => `item-${id}`;

function render(item: Item): HTMLElement {
  const box = el('div', `item ${item.kind}`);
  box.id = domId(item.id);
  const tab = store.active!;
  switch (item.kind) {
    case 'user': {
      const who = el('div', 'who', item.auto ? '> AUTO-CONTINUE' : '> YOU');
      if (item.auto) box.classList.add('auto');
      const label = item.text.split('\n')[0].slice(0, 40) || item.attachments?.[0]?.name || 'attachment';
      if (!item.paint) {
        const undo = button('UNDO FROM HERE', () => askUndo(tab, item.id, label), 'undo-btn');
        undo.title = "Put back every file Claude changed after this message";
        who.append(undo);
      }
      box.append(who);
      if (item.attachments?.length) box.append(attachRow(item.attachments));
      if (item.text) box.append(el('div', 'body', item.text));
      if (item.route) box.append(el('div', 'route', `AUTO → ${item.route.model.toUpperCase()}${item.route.effort ? ` · ${item.route.effort.toUpperCase()}` : ''} — ${item.route.reason}`));
      break;
    }
    case 'claude': {
      const body = el('div', 'body md');
      setMarkdown(body, item.text);
      const who = el('div', 'who', `> ${item.who?.toUpperCase() ?? 'CLAUDE'}`);
      if (item.at) {
        const when = el('span', 'when', whenText(item.at));
        when.dataset.at = String(item.at);
        when.title = whenFull(item.at);
        who.append(when);
      }
      box.append(who, body);
      break;
    }
    case 'tool': {
      if (item.error) box.classList.add('error');
      const line = el('div', 'line');
      line.append(el('span', 'name', item.name), el('span', 'detail', ` ${item.detail}`));
      box.append(line);
      if (item.body) {
        box.classList.add('expandable');
        line.onclick = () => {
          const open = box.querySelector('pre');
          if (open) open.remove();
          else box.append(diffBlock(item.body!));
        };
      }
      break;
    }
    case 'note':
      box.append(el('div', 'body', item.text));
      break;
    case 'perm':
      box.append(el('div', 'who', '! PERMISSION'), el('div', 'title', item.title));
      if (item.tool === 'ExitPlanMode') {
        const plan = el('div', 'body md plan');
        setMarkdown(plan, planText(item.detail));
        box.append(plan);
      } else box.append(diffBlock(item.detail));
      if (item.status === 'pending') {
        const row = el('div', 'buttons');
        row.append(button('ALLOW', () => send({ t: 'perm', tab, id: item.id, allow: true }), 'primary'), button('DENY', () => send({ t: 'perm', tab, id: item.id, allow: false })));
        box.append(row);
      } else {
        box.append(el('div', 'status', `[${item.status.toUpperCase()}]`));
      }
      break;
    case 'ask':
      renderAsk(box, item, tab);
      break;
    case 'image':
      renderImage(box, item);
      break;
  }
  return box;
}

const secs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`);

// A picture from the local image model: its progress while it is made, then the picture (tap = full size, over the
// chat: an outside browser is not logged in, and an older desktop app has no way to open the file),
// SAVE (download) and, in the desktop app, SHOW IN FOLDER.
// A picture full size over the chat. A click, Esc or CLOSE closes it. In the desktop app OPEN IN VIEWER hands the
// file to the system image viewer (there Left/Right go through its folder).
function showPicture(url: string, alt: string, path?: string): void {
  const dlg = el('dialog', 'img-view');
  const img = el('img');
  img.src = url;
  img.alt = alt;
  const close = () => dlg.close();
  img.onclick = close;
  dlg.onclick = (e) => e.target === dlg && close(); // the dark area around it
  dlg.onclose = () => dlg.remove();
  const row = el('div', 'img-row');
  if (path && shellApi?.openImage) {
    row.append(button('OPEN IN VIEWER', () => void shellApi!.openImage!(path).then((ok) => (ok ? close() : toast("Couldn't open the picture."))), 'img-btn'));
  }
  row.append(button('CLOSE', close, 'img-btn'));
  dlg.append(img, row);
  document.body.append(dlg);
  dlg.showModal();
}

// Reply times ("5 MIN AGO") move on once a minute.
setInterval(() => {
  for (const t of document.querySelectorAll<HTMLElement>('.when[data-at]')) t.textContent = whenText(Number(t.dataset.at));
}, 30_000);

// The time on pictures being painted moves every second, between the server's updates.
setInterval(() => {
  for (const t of document.querySelectorAll<HTMLElement>('.img-time')) t.textContent = ` · ${secs(Date.now() - Number(t.dataset.started))}`;
}, 1000);

function renderImage(box: HTMLElement, item: ImageItem): void {
  box.append(el('div', 'who', `> ${item.model.replace(/\s*\(local\)\s*$/i, '').toUpperCase()}`));
  // A cloud picture (Gemini) has no seed or steps (0).
  const facts = [`${item.width}x${item.height}`, item.seed ? `seed ${item.seed}` : '', item.steps ? `${item.steps} steps${item.fast ? '' : ' (best)'}` : '', item.edit ? 'edit' : ''];
  if (item.status === 'done' && item.file) {
    const url = `/api/images/${encodeURIComponent(item.file)}`;
    const link = el('a', 'img-full');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = 'Open full size';
    link.style.setProperty('--ar', String(item.width / item.height));
    link.onclick = (e) => {
      e.preventDefault();
      showPicture(url, item.prompt, item.path);
    };
    const img = el('img');
    img.src = url;
    img.alt = item.prompt;
    img.width = item.width;
    img.height = item.height;
    link.append(img);
    const row = el('div', 'img-row');
    const save = el('a', 'img-btn', 'SAVE');
    save.href = url;
    save.download = item.file;
    save.title = 'Download the PNG';
    row.append(save);
    const path = item.path;
    if (path && shellApi?.showInFolder) {
      row.append(button('SHOW IN FOLDER', () => void shellApi!.showInFolder!(path).then((ok) => ok || toast("Couldn't open the file manager.")), 'img-btn'));
    }
    row.append(el('span', 'img-facts', [...facts, item.ms ? secs(item.ms) : ''].filter(Boolean).join(' · ')));
    row.title = path ?? '';
    box.append(link, row);
    return;
  }
  const state =
    item.status === 'queued' ? `QUEUED · ${(item.phase ?? 'waiting for the GPU').toUpperCase()}`
    : item.status === 'painting' ? `${(item.phase ?? 'Painting').toUpperCase()}${item.phase === 'Painting' && item.step ? ` ${item.step}/${item.steps}` : ''}`
    : item.status === 'cancelled' ? 'STOPPED BEFORE IT STARTED'
    : `FAILED: ${item.error ?? 'unknown error'}`;
  const line = el('div', `img-state ${item.status}`, state);
  if (item.status === 'painting' && item.startedAt) {
    const t = el('span', 'img-time', ` · ${secs(Date.now() - item.startedAt)}`);
    t.dataset.started = String(item.startedAt);
    line.append(t);
  }
  box.append(line);
  if (item.status === 'painting' && item.step) {
    const bar = el('div', 'img-bar');
    bar.style.setProperty('--pct', `${Math.round((100 * item.step) / item.steps)}%`);
    box.append(bar);
  }
  box.append(el('div', 'img-facts', facts.filter(Boolean).join(' · ')));
}

// Images as thumbnails (tap for full size); other files as chips. id '' = no saved copy.
function attachRow(list: Attachment[]): HTMLElement {
  const row = el('div', 'att-row');
  for (const a of list) {
    if (a.kind === 'image' && a.id) {
      const link = el('a', 'att-thumb');
      link.href = `/api/upload/${a.id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = a.name;
      const img = el('img');
      img.src = link.href;
      img.alt = a.name;
      img.loading = 'lazy';
      link.append(img);
      row.append(link);
    } else {
      row.append(el('span', 'att-chip-sm', `[${a.kind === 'image' ? 'IMAGE' : 'FILE'}] ${a.name}`));
    }
  }
  return row;
}

// Lines starting "+ " / "- " get classes so the theme can show a diff.
// A plan comes as markdown. Older chats saved the tool input as JSON instead, sometimes cut short.
function planText(detail: string): string {
  if (!detail.startsWith('{"plan":"')) return detail;
  try {
    return String(JSON.parse(detail).plan);
  } catch {
    return detail.slice(9).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
}

function diffBlock(text: string): HTMLPreElement {
  const pre = el('pre', 'code');
  for (const line of text.split('\n')) {
    const cls = line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : '';
    pre.append(el('span', cls, line + '\n'));
  }
  return pre;
}

function renderAsk(box: HTMLElement, item: Extract<Item, { kind: 'ask' }>, tab: string): void {
  box.append(el('div', 'who', '? QUESTION'));
  if (item.status !== 'pending') {
    for (const q of item.questions) box.append(el('div', 'title', q.question), el('div', 'status', `[${item.answers?.[q.question] ?? item.status.toUpperCase()}]`));
    return;
  }
  const picked = new Map<string, Set<string>>();
  const typed = new Map<string, HTMLInputElement>();
  for (const q of item.questions) {
    const chosen = new Set<string>();
    picked.set(q.question, chosen);
    const row = el('div', 'options');
    for (const opt of q.options) {
      const b = button(
        opt.label,
        () => {
          if (!q.multiSelect) {
            chosen.clear();
            row.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
          }
          if (chosen.has(opt.label)) chosen.delete(opt.label);
          else chosen.add(opt.label);
          b.classList.toggle('on', chosen.has(opt.label));
        },
        'option',
      );
      if (opt.description) b.title = opt.description;
      row.append(b);
    }
    const other = el('input', 'other');
    other.placeholder = 'Or type your own answer';
    typed.set(q.question, other);
    box.append(el('div', 'title', q.question), row, other);
  }
  const actions = el('div', 'buttons');
  actions.append(
    button(
      'ANSWER',
      () => {
        const answers: Record<string, string> = {};
        for (const q of item.questions) answers[q.question] = [...picked.get(q.question)!, typed.get(q.question)!.value.trim()].filter(Boolean).join(', ');
        send({ t: 'ask', tab, id: item.id, answers });
      },
      'primary',
    ),
    button('SKIP', () => send({ t: 'ask', tab, id: item.id, answers: null })),
  );
  box.append(actions);
}
