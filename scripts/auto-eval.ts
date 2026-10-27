// AUTO router check: runs ONLY the router (the decision model, else one small Haiku call) on the first message of
// your recent chats, and prints what it would pick and who picked it. No prompt is sent to a model that works on it; nothing is written.
//   npx tsx scripts/auto-eval.ts [N=30]
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { routeMessage } from '../server/router.ts';

const N = Math.max(1, Number(process.argv[2]) || 30);

// Text the app or Claude Code adds around real messages; not something the owner typed.
const NOT_TYPED = /^(\[Note from the |Auto-continue:|<command-|<local-command|<system-reminder|Caveat:)/;

async function firstMessage(sessionId: string): Promise<{ text: string; files: number } | null> {
  for (const m of await getSessionMessages(sessionId, { limit: 12 })) {
    if (m.type !== 'user') continue;
    const c = (m.message as { content?: unknown }).content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? (c as { type?: string; text?: string }[]) : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    if (!text || NOT_TYPED.test(text)) continue;
    return { text, files: blocks.filter((b) => b.type === 'image' || b.type === 'document').length };
  }
  return null;
}

const rows: string[][] = [];
for (const s of await listSessions({ limit: N * 3 })) {
  if (rows.length >= N) break;
  const first = await firstMessage(s.sessionId).catch(() => null);
  if (!first) continue;
  const r = await routeMessage({ text: first.text, attachments: first.files, title: first.text.split('\n')[0].slice(0, 32), turns: 0, current: null, lastReply: '' });
  const date = new Date(s.lastModified).toISOString().slice(0, 10);
  const head = first.text.replace(/\s+/g, ' ').slice(0, 70);
  rows.push([date, head, r.pick?.model ?? '?', r.pick?.effort ?? '?', r.pick ? `${r.engine}: ${r.pick.reason}` : `FAILED: ${r.error}`]);
}

const head = ['DATE', 'FIRST MESSAGE', 'MODEL', 'EFFORT', 'REASON'];
const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
for (const r of [head, ...rows]) console.log(r.map((c, i) => (i < 4 ? c.padEnd(width[i]) : c)).join('  '));
const count = (k: number) => Object.entries(rows.reduce<Record<string, number>>((a, r) => ((a[r[k]] = (a[r[k]] ?? 0) + 1), a), {})).map(([v, n]) => `${v} ${n}`).join(', ');
console.log(`\n${rows.length} chats. Models: ${count(2)}. Effort: ${count(3)}.`);
