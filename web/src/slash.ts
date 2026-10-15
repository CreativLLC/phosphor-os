import type { CommandsResponse, SlashCommandInfo } from '../../shared/protocol.ts';
import { openMcp } from './mcp.ts';
import { store } from './store.ts';
import { el } from './ui.ts';

// "/" menu: type / at the start of the message box to see Claude Code's slash commands (built-in ones,
// skills, plugins, your own). Arrows move, Enter runs, Tab fills in, Esc closes. Tap fills in on a phone.
// The terminal's full-screen menus (like /mcp) can't show here; the app opens its own screen instead.

// Commands the app runs itself when typed with nothing after them.
const APP_COMMANDS: Record<string, { description: string; run: () => void }> = {
  mcp: { description: 'Open the MCP screen: servers, status, reconnect, on/off', run: openMcp },
};
const CACHE_MS = 2 * 60 * 1000;
const MAX_ROWS = 60;

let input: HTMLTextAreaElement;
let sendBtn: HTMLButtonElement;
let menu: HTMLElement;
let shown: SlashCommandInfo[] = [];
let pick = 0;
const cache = new Map<string, { at: number; list: Promise<SlashCommandInfo[]> }>(); // per tab

// Run an app command (e.g. "/mcp") instead of sending it to Claude. True if it ran.
export function runAppCommand(text: string): boolean {
  const cmd = APP_COMMANDS[text.trim().replace(/^\//, '')];
  if (!text.trim().startsWith('/') || !cmd) return false;
  cmd.run();
  return true;
}

export function mountSlash(composer: HTMLElement): void {
  input = composer.querySelector('#input') as HTMLTextAreaElement;
  sendBtn = composer.querySelector('#send') as HTMLButtonElement;
  menu = el('div', 'slash-menu');
  menu.id = 'slash-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  composer.append(menu);
  input.setAttribute('aria-controls', menu.id);

  input.addEventListener('input', () => void update());
  // Leaving the box closes the menu (a little later, so a tap on a row still lands; not if the box got focus back).
  input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && close(), 150));
  // Capture on the composer, so these keys never reach the message box's own Enter-to-send.
  composer.addEventListener(
    'keydown',
    (e) => {
      if (menu.hidden || e.target !== input || e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!shown.length) return;
        pick = (pick + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        highlight();
      } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (!shown.length) return;
        choose(shown[pick], e.key === 'Enter');
      } else if (e.key === 'Escape') {
        close();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  store.on((c) => {
    if (c.kind === 'active') close();
  });
}

export function commands(tab: string): Promise<SlashCommandInfo[]> {
  const hit = cache.get(tab);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const list = fetch(`/api/commands?tab=${encodeURIComponent(tab)}`)
    .then((r) => r.json() as Promise<CommandsResponse>)
    .then((r) => {
      if (!Array.isArray(r.commands)) throw new Error('no list');
      return r.commands;
    });
  cache.set(tab, { at: Date.now(), list });
  list.catch(() => cache.delete(tab)); // try again next time
  return list;
}

async function update(): Promise<void> {
  const m = input.value.match(/^\/([\w:.-]*)$/);
  const tab = store.active;
  if (!m || !tab || store.demo) return close();
  const typed = m[1].toLowerCase();
  if (menu.hidden) {
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  let all: SlashCommandInfo[];
  try {
    if (!cache.has(tab)) menu.replaceChildren(el('div', 'slash-empty', 'Loading commands…'));
    all = await commands(tab);
  } catch {
    menu.replaceChildren(el('div', 'slash-empty', 'Could not load the commands. Type the command and send it.'));
    return;
  }
  if (input.value !== `/${m[1]}`) return; // typed on while loading; that keystroke updates again
  // Starts with what you typed first, then contains it.
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(typed));
  const has = all.filter((c) => !c.name.toLowerCase().startsWith(typed) && c.name.toLowerCase().includes(typed));
  shown = [...starts.sort((a, b) => a.name.localeCompare(b.name)), ...has].slice(0, MAX_ROWS);
  pick = 0;
  if (!shown.length) {
    menu.replaceChildren(el('div', 'slash-empty', 'No command starts with that. Enter sends it as typed.'));
    return;
  }
  menu.replaceChildren(...shown.map(row));
  highlight();
}

function row(c: SlashCommandInfo, i: number): HTMLElement {
  const r = el('div', 'slash-row');
  r.id = `slash-${i}`;
  r.setAttribute('role', 'option');
  const app = APP_COMMANDS[c.name];
  r.append(el('span', 'slash-name', `/${c.name}`));
  if (c.hint && !app) r.append(el('span', 'slash-hint', c.hint));
  r.append(el('span', 'slash-desc', app?.description ?? c.description));
  if (!c.builtin) r.classList.add('slash-skill');
  // pointerdown + preventDefault keeps the keyboard up on a phone; the click picks.
  r.addEventListener('pointerdown', (e) => e.preventDefault());
  r.addEventListener('click', () => choose(c, false));
  return r;
}

function highlight(): void {
  menu.querySelectorAll('.slash-row').forEach((r, i) => {
    r.classList.toggle('on', i === pick);
    r.setAttribute('aria-selected', String(i === pick));
  });
  menu.querySelector<HTMLElement>('.slash-row.on')?.scrollIntoView({ block: 'nearest' });
  input.setAttribute('aria-activedescendant', `slash-${pick}`);
}

// Enter on a command with nothing to add runs it, like the terminal. Tab or a tap fills it in.
function choose(c: SlashCommandInfo, run: boolean): void {
  close();
  const app = APP_COMMANDS[c.name];
  if (app && run) {
    setInput('');
    input.blur(); // the screen it opens takes the keys (Esc closes it)
    app.run();
    return;
  }
  if (run && !c.hint) {
    input.value = `/${c.name}`; // no input event: that would open the menu again
    sendBtn.click();
    return;
  }
  setInput(`/${c.name} `);
}

export function setInput(text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input')); // saves the draft, resizes the box
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

function close(): void {
  if (menu.hidden) return;
  menu.hidden = true;
  shown = [];
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}
