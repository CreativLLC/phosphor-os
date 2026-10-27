import { store } from './store.ts';

// FOCUS: hide the left panel, the right panel, or both (for screen recordings). The chat then sits in the middle
// at a readable width (focus.css). Remembered per browser; index.html puts the classes on <html> before first paint.
// Keys: Ctrl+[ left, Ctrl+] right, Ctrl+\ both. (Phones and the folded layout ignore it: focus.css is wide-screen only.)
const KEY = 'phosphor.view';
type Side = 'left' | 'right';
const SIDES: Side[] = ['left', 'right'];

const root = document.documentElement;
const hidden = (s: Side) => root.classList.contains(`hide-${s}`);

// The launcher opens a right-panel view: bring the panel back if it is hidden.
export function showRight(): void {
  if (hidden('right')) document.getElementById('btn-hide-right')?.click();
}

export function mountFocus(btns: Record<Side | 'focus', HTMLButtonElement>): void {
  const sync = () => {
    for (const s of SIDES) {
      btns[s].classList.toggle('on', !hidden(s));
      btns[s].setAttribute('aria-pressed', String(!hidden(s)));
      if (!hidden(s)) btns[s].classList.remove('news');
    }
    btns.focus.classList.toggle('on', hidden('left') && hidden('right'));
    try {
      localStorage.setItem(KEY, JSON.stringify({ left: hidden('left'), right: hidden('right') }));
    } catch {
      /* storage blocked: the view just is not remembered */
    }
  };
  const set = (s: Side, hide: boolean) => root.classList.toggle(`hide-${s}`, hide);
  const toggle = (s: Side) => {
    set(s, !hidden(s));
    sync();
  };
  // Both hidden -> show both. Otherwise hide both.
  const toggleFocus = () => {
    const hide = !(hidden('left') && hidden('right'));
    for (const s of SIDES) set(s, hide);
    sync();
  };
  btns.left.onclick = () => toggle('left');
  btns.right.onclick = () => toggle('right');
  btns.focus.onclick = toggleFocus;

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (e.code === 'BracketLeft') toggle('left');
    else if (e.code === 'BracketRight') toggle('right');
    else if (e.code === 'Backslash') toggleFocus();
    else return;
    e.preventDefault();
  });

  // A small dot on a hidden panel's button when a chat needs you or finishes (the chat tab bar shows it too).
  const prev = new Map<string, { busy: boolean; attention: boolean }>();
  let primed = false;
  store.on((c) => {
    if (c.kind !== 'tabs') return;
    let news = false;
    for (const t of store.tabs.values()) {
      const p = prev.get(t.meta.id);
      if (primed && ((t.meta.attention && !p?.attention) || (p?.busy && !t.meta.busy))) news = true;
      prev.set(t.meta.id, { busy: t.meta.busy, attention: t.meta.attention });
    }
    for (const id of [...prev.keys()]) if (!store.tabs.has(id)) prev.delete(id);
    primed = true;
    if (news) for (const s of SIDES) if (hidden(s)) btns[s].classList.add('news');
  });

  sync();
}
