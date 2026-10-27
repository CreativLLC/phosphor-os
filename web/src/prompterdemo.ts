import { parsePoints, type AfterJob, type CuePoint, type PromptList, type PrompterLive } from '../../shared/prompter.ts';

// Fake data for PROMPTER in demo mode (/?demo=1): a recording that is running, with points that tick off as the
// made-up speaker talks. No mic, no server.

const MIN = 60_000;
const TICK_MS = 9000; // the next point ticks this often
const LINE_MS = 1800; // a new line of words this often

const LISTS: PromptList[] = [
  {
    id: 'demo1',
    name: 'Video 12: local AI on a budget',
    updated: Date.now() - 2 * 3600_000,
    text: [
      'Cold open: my power bill last month',
      '  show the screenshot',
      'Why run AI on your own PC',
      '  privacy, no monthly fee, works offline',
      'The hardware I use',
      'Picking a model that fits your card',
      'Setup in ten minutes',
      'First real test: summarize my inbox',
      'Where it falls short',
      'Call to action: the guide in the description',
    ].join('\n'),
  },
  { id: 'demo2', name: 'Short: three keyboard tricks', updated: Date.now() - 3 * 86400_000, text: 'Window snapping\nThe launcher\nDictate anywhere' },
];

const WORDS = [
  'so the first thing people ask me is what graphics card do I need,',
  'and honestly the answer is less than you think.',
  'I am on a card that is four years old and it runs a thirty billion parameter model',
  'as long as you pick one that fits in the memory you have.',
  'the trick is the quantized versions, they are smaller and still really good,',
  'so let me show you how I pick one for a twelve gig card.',
];

let live: PrompterLive = {
  id: 'demo-live',
  name: LISTS[0].name,
  startedAt: Date.now() - 7 * MIN - 42_000,
  endedAt: null,
  points: parsePoints(LISTS[0].text).map((p, i): CuePoint => ({
    ...p,
    done: i < 3,
    by: i < 3 ? (i === 1 ? 'hand' : 'model') : null,
    at: i < 3 ? (i + 1) * 2 * MIN : null,
    yes: i < 3 ? 0.95 : 0.1,
    quote: '',
  })),
  heard: WORDS.slice(0, 2).join(' '),
  words: 1184,
  mic: 'on',
  level: 0.6,
  engine: { ready: true, label: 'LOCAL DECISION MODEL', note: '' },
  calls: 312,
  callMs: 240,
  error: '',
  v: 1,
};
let lastTick = Date.now();
let lastLine = Date.now();
let line = 2;
let afterPolls = 0;
let afterText = '';

// Move the fake recording on: new words, now and then a point ticks.
function advance(): void {
  if (live.endedAt) return;
  const now = Date.now();
  if (now - lastLine >= LINE_MS) {
    lastLine = now;
    line = (line + 1) % WORDS.length;
    const said = [WORDS[(line + WORDS.length - 2) % WORDS.length], WORDS[(line + WORDS.length - 1) % WORDS.length], WORDS[line]].join(' ');
    live = { ...live, heard: said.length > 220 ? `…${said.slice(-220).replace(/^\S*\s/, '')}` : said, words: live.words + 14, level: 0.3 + ((line * 37) % 60) / 100, v: live.v + 1 };
  }
  const next = live.points.find((p) => !p.done);
  if (next && now - lastTick >= TICK_MS && live.points.filter((p) => p.done).length < live.points.length - 3) {
    lastTick = now;
    next.done = true;
    next.by = 'model';
    next.at = now - live.startedAt;
    live = { ...live, v: live.v + 1 };
  }
}

export async function demoPrompterApi<T>(path: string, method: string, body: unknown): Promise<T> {
  await new Promise((r) => setTimeout(r, 60));
  const b = (body ?? {}) as Record<string, unknown>;
  const out = (v: unknown) => v as T;
  if (path.startsWith('live?') || path === 'live') {
    advance();
    return out({ live, engine: live.engine, now: Date.now() });
  }
  if (path === 'live/start') {
    const points = parsePoints(String(b.text ?? '')).map((p): CuePoint => ({ ...p, done: false, by: null, at: null, yes: null, quote: '' }));
    live = { ...live, id: `demo-${Date.now()}`, name: String(b.name || 'Recording'), startedAt: Date.now(), endedAt: null, points, heard: '', words: 0, v: live.v + 1 };
    lastTick = Date.now();
    return out({ live, mic: 'demo' });
  }
  if (path === 'live/mark') {
    const p = live.points.find((x) => x.id === b.id);
    if (p) Object.assign(p, { done: b.done === true, by: b.done === true ? 'hand' : null });
    live = { ...live, v: live.v + 1 };
    return out({ live });
  }
  if (path === 'live/stop') {
    live = { ...live, endedAt: Date.now(), mic: 'off', level: 0, v: live.v + 1 };
    return out({ live });
  }
  if (path === 'live/mic') return out({ mic: 'demo' });
  if (path === 'lists' && method === 'GET') return out({ lists: LISTS.map((l) => ({ id: l.id, name: l.name, points: parsePoints(l.text).length, updated: l.updated })) });
  if (path === 'lists' && method === 'POST') {
    const l: PromptList = { id: String(b.id || `demo${LISTS.length + 1}`), name: String(b.name || 'New list'), text: String(b.text ?? ''), updated: Date.now() };
    const at = LISTS.findIndex((x) => x.id === l.id);
    if (at >= 0) LISTS[at] = l;
    else LISTS.unshift(l);
    return out(l);
  }
  const lm = /^lists\/(.+)$/.exec(path);
  if (lm) {
    const at = LISTS.findIndex((x) => x.id === decodeURIComponent(lm[1]));
    if (method === 'DELETE') {
      if (at >= 0) LISTS.splice(at, 1);
      return out({ ok: true });
    }
    if (at < 0) throw new Error('not found');
    return out(LISTS[at]);
  }
  if (path === 'sessions') return out({ sessions: [{ id: 'demo-old', name: 'Video 11: home server tour', startedAt: Date.now() - 4 * 86400_000, endedAt: null, words: 3120 }] });
  if (path.startsWith('sessions/')) {
    return out({ id: 'demo-old', name: 'Video 11: home server tour', list: 'The rack\nPower use\nBackups\nWhat I would change', text: '[00:05] Hi, today a tour of my home server.\n[01:10] First the rack itself, it is a small one.\n[04:30] Backups run every night to a second box.' });
  }
  if (path === 'after') {
    afterPolls = 0;
    afterText = String(b.points ?? '');
    return out({ id: 'demo' });
  }
  if (path.startsWith('after/')) {
    afterPolls++;
    const points = parsePoints(afterText).map((p, i) => ({
      ...p,
      covered: i % 3 !== 2,
      quote: i % 3 !== 2 ? WORDS[i % WORDS.length] : '',
      at: i % 3 !== 2 ? `${i * 2}:${String((i * 17) % 60).padStart(2, '0')}` : '',
    }));
    const job: AfterJob = { id: 'demo', state: afterPolls < 3 ? 'running' : 'done', done: Math.min(afterPolls * 9, 24), total: 24, points, error: '', by: 'LOCAL DECISION MODEL' };
    return out(job);
  }
  throw new Error('not found');
}
