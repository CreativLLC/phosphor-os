// Small DOM helpers shared by all components.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

// Swap an element for a text field in place: Enter or clicking away saves, Escape cancels.
export function editInline(target: HTMLElement, value: string, save: (v: string) => void, done?: () => void): void {
  const input = el('input', 'inline-edit');
  input.value = value;
  input.maxLength = 60;
  let finished = false;
  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    input.replaceWith(target);
    if (keep && v && v !== value) save(v);
    done?.();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  target.replaceWith(input);
  input.focus();
  input.select();
}

export function toast(text: string, ms = 4000): void {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = el('div', 'toast', text);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function timeAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// Show a path relative to the tab's folder when it is inside it.
export function shortPath(path: string, cwd: string): string {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/$/, '');
  const p = norm(path);
  const c = norm(cwd);
  return p.toLowerCase().startsWith(c.toLowerCase() + '/') ? p.slice(c.length + 1) : p;
}

export function folderName(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/$/, '').split('/').pop() || path;
}

// Themed yes/no box. Resolves true for OK, false for CANCEL / Escape.
export function confirmBox(title: string, text: string, okLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    const d = el('dialog', 'confirm-box');
    const done = (v: boolean) => {
      d.close();
      d.remove();
      resolve(v);
    };
    const row = el('div', 'buttons');
    row.append(button(okLabel, () => done(true), 'primary'), button('CANCEL', () => done(false)));
    d.append(el('h2', '', title), el('p', '', text), row);
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(false);
    });
    document.body.append(d);
    d.showModal();
  });
}

// Themed menu box: a title and one button per choice, one under another. Resolves the chosen value, or null for
// CANCEL / Escape. A choice with `head` is a plain heading line between the buttons.
export function pickBox<T>(title: string, choices: ({ label: string; value: T } | { head: string })[]): Promise<T | null> {
  return new Promise((resolve) => {
    const d = el('dialog', 'confirm-box pick-box');
    const done = (v: T | null) => {
      d.close();
      d.remove();
      resolve(v);
    };
    const list = el('div', 'pick-list');
    for (const c of choices) list.append('head' in c ? el('div', 'pick-head', c.head) : button(c.label, () => done(c.value)));
    const row = el('div', 'buttons');
    row.append(button('CANCEL', () => done(null)));
    d.append(el('h2', '', title), list, row);
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    document.body.append(d);
    d.showModal();
  });
}
