import type { McpAction, McpResponse, McpServer } from '../../shared/protocol.ts';
import { store } from './store.ts';
import { button, el, folderName, toast } from './ui.ts';

// MCP screen: the MCP servers (tools from other apps, like Gmail) this chat can use, with a status for each,
// RECONNECT and TURN ON / TURN OFF. Opened from the MCP button or by typing /mcp.
// Adding a server stays in the terminal (`claude mcp add`): a server is a program that runs on this PC.

const STATUS: Record<string, { label: string; cls: string; help: string }> = {
  connected: { label: 'ON', cls: 'on', help: 'Connected. Claude can use its tools.' },
  pending: { label: 'WAIT', cls: 'wait', help: 'Connecting…' },
  'needs-auth': { label: 'LOGIN', cls: 'login', help: 'Needs a login before Claude can use it.' },
  failed: { label: 'FAIL', cls: 'fail', help: 'Could not connect.' },
  disabled: { label: 'OFF', cls: 'off', help: 'Turned off for this folder.' },
};
const SOURCES: Record<string, string> = { claudeai: 'CLAUDE.AI', user: 'YOU', project: 'PROJECT', local: 'THIS FOLDER', plugin: 'PLUGIN', managed: 'ADMIN', enterprise: 'ADMIN' };
const CONNECTORS_URL = 'https://claude.ai/settings/connectors';
const POLL_MS = 1500;
const POLL_MAX = 12;

let drawer: HTMLElement;
let list: HTMLElement;
let sub: HTMLElement;
let polls = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
const busy = new Set<string>(); // servers with an action running

export function mountMcp(drawerEl: HTMLElement, openBtn: HTMLElement): void {
  drawer = drawerEl;
  sub = el('p', 'mcp-sub');
  list = el('div', 'mcp-list');
  const head = el('div', 'drawer-head');
  const tools = el('div', 'mcp-head-tools');
  tools.append(button('REFRESH', () => void load()), button('CLOSE', closeMcp));
  head.append(el('h2', '', 'MCP SERVERS'), tools);
  const foot = el('p', 'mcp-foot');
  foot.append('Add a server: in a terminal, run ', el('code', '', 'claude mcp add'), '. Then press REFRESH.');
  drawer.replaceChildren(head, sub, list, foot);
  drawer.tabIndex = -1; // takes focus when opened
  // Esc closes it, wherever the focus is (a pressed button is redrawn, so focus can drop to the page).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden && !document.querySelector('dialog[open]')) closeMcp();
  });
  openBtn.onclick = () => (drawer.hidden ? openMcp() : closeMcp());
  // Only one drawer at a time.
  document.getElementById('btn-history')?.addEventListener('click', closeMcp);
  // Another tab can be in another folder, with other servers.
  store.on((c) => {
    if (c.kind === 'active' && !drawer.hidden) {
      list.replaceChildren();
      polls = 0;
      void load();
    }
  });
}

export function openMcp(): void {
  document.getElementById('history')!.hidden = true;
  drawer.hidden = false;
  drawer.focus();
  polls = 0;
  void load();
}

function closeMcp(): void {
  drawer.hidden = true;
  clearTimeout(pollTimer);
}

async function load(): Promise<void> {
  const tab = store.current();
  if (!tab) return show({ servers: [], error: 'Open a chat tab first.' });
  sub.textContent = `Tools Claude can use in this chat. Folder: ${folderName(tab.info.cwd)}`;
  if (!list.childElementCount) list.replaceChildren(el('div', 'empty', 'Asking Claude…'));
  try {
    const r = await fetch(`/api/mcp?tab=${encodeURIComponent(tab.meta.id)}`);
    show((await r.json()) as McpResponse);
  } catch {
    show({ servers: [], error: 'Could not reach the app server. Try REFRESH.' });
  }
}

async function act(name: string, action: McpAction): Promise<void> {
  const tab = store.current();
  if (!tab) return;
  busy.add(name);
  render(lastServers);
  try {
    const r = await fetch('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab: tab.meta.id, name, action }) });
    const data = (await r.json()) as McpResponse;
    if (data.error) toast(`${shortName(name)}: ${data.error}`, 6000);
    busy.delete(name);
    polls = 0;
    show(data);
  } catch {
    busy.delete(name);
    toast('Could not reach the app server.');
    render(lastServers);
  }
}

let lastServers: McpServer[] = [];

function show(r: McpResponse): void {
  if (drawer.hidden) return;
  lastServers = r.servers ?? [];
  render(lastServers, r.error);
  // Servers still connecting: look again shortly.
  clearTimeout(pollTimer);
  if (lastServers.some((s) => s.status === 'pending') && polls++ < POLL_MAX) pollTimer = setTimeout(() => void load(), POLL_MS);
}

function shortName(name: string): string {
  return name.replace(/^claude\.ai /, '');
}

function render(servers: McpServer[], error?: string): void {
  const rows: HTMLElement[] = [];
  if (error && !servers.length) rows.push(el('div', 'empty', error));
  else if (!servers.length) rows.push(el('div', 'empty', 'No MCP servers yet.'));
  const count = (st: string) => servers.filter((s) => s.status === st).length;
  if (servers.length) {
    const parts = [`${count('connected')} ON`, count('needs-auth') && `${count('needs-auth')} NEED LOGIN`, count('failed') && `${count('failed')} FAILED`, count('disabled') && `${count('disabled')} OFF`];
    rows.push(el('div', 'mcp-count', parts.filter(Boolean).join(' · ')));
  }
  // Problems first, then on, then off; by name inside each group.
  const order = ['needs-auth', 'failed', 'pending', 'connected', 'disabled'];
  const sorted = [...servers].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || shortName(a.name).localeCompare(shortName(b.name)));
  for (const s of sorted) rows.push(row(s));
  list.replaceChildren(...rows);
}

function row(s: McpServer): HTMLElement {
  const st = STATUS[s.status] ?? { label: s.status.toUpperCase(), cls: 'wait', help: '' };
  const r = el('div', `mcp-row mcp-${st.cls}`);
  const lamp = el('span', 'mcp-lamp', st.label);
  lamp.title = st.help;
  const name = el('span', 'mcp-name', shortName(s.name));
  const meta = [SOURCES[s.source] ?? s.source.toUpperCase(), s.tools.length ? `${s.tools.length} TOOLS` : '', /^\d/.test(s.version ?? '') ? `v${s.version}` : ''].filter(Boolean).join(' · ');
  const top = el('div', 'mcp-top');
  top.append(lamp, name, el('span', 'mcp-meta', meta));
  r.append(top);

  if (s.status === 'needs-auth') {
    const help = el('p', 'mcp-help');
    if (s.source === 'claudeai') {
      const link = el('a', '', 'claude.ai > Settings > Connectors');
      link.href = CONNECTORS_URL;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      help.append('Log in at ', link, '. Then press RECONNECT.');
    } else {
      help.append('Log in from a terminal: run ', el('code', '', 'claude'), ', type ', el('code', '', '/mcp'), ', pick this server. Then press RECONNECT.');
    }
    r.append(help);
  } else if (s.error) {
    r.append(el('p', 'mcp-help mcp-error', s.error));
  }

  if (s.tools.length) {
    const d = el('details', 'mcp-tools');
    d.append(el('summary', '', 'TOOLS'), el('p', '', s.tools.join(', ')));
    r.append(d);
  }

  const btns = el('div', 'mcp-btns');
  if (busy.has(s.name)) {
    btns.append(el('span', 'mcp-working', 'WORKING…'));
  } else {
    if (s.status !== 'disabled') btns.append(button('RECONNECT', () => void act(s.name, 'reconnect')));
    btns.append(s.status === 'disabled' ? button('TURN ON', () => void act(s.name, 'enable')) : button('TURN OFF', () => void act(s.name, 'disable')));
  }
  r.append(btns);
  return r;
}
