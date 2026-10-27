// OPERATOR scene (web/src/sceneplan.ts): tool -> activity table, what the mascot acts out, crew walking in and
// out; and the scene art (web/src/sprites/mascot.ts, troupe.ts, room.ts) builds with even rows and known colors.
//   npx tsx tests/scene.ts

import { readFileSync } from 'node:fs';
import type { Agent, Item, TabState } from '../shared/protocol.ts';
import { RAMPS } from '../web/src/sprites/engine.ts';
import { mascotAnim, MASCOT_H, MASCOT_W } from '../web/src/sprites/mascot.ts';
import { roomAnim, ROOM_H } from '../web/src/sprites/room.ts';
import { TROUPE_H, TROUPE_LOOKS, TROUPE_W, troupeAnim } from '../web/src/sprites/troupe.ts';
import {
  crewSlots,
  DONE_MS,
  endedInError,
  ENTER_MS,
  LEAVE_MS,
  lineActivity,
  MAX_CREW,
  nextCrewChange,
  planCrew,
  sceneActivity,
  toolActivity,
  type Activity,
  type Walker,
} from '../web/src/sceneplan.ts';

let pass = 0;
let fail = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${g}\n  want ${w}`);
  }
};

// ---------- Tool table and activity line ----------

eq('Read reads', toolActivity('Read'), 'read');
eq('Grep reads', toolActivity('Grep'), 'read');
eq('Edit edits', toolActivity('Edit'), 'edit');
eq('Write edits', toolActivity('Write'), 'edit');
eq('Bash is shell work', toolActivity('Bash'), 'shell');
eq("Gemini's Run is shell work", toolActivity('Run'), 'shell');
eq('WebSearch looks out', toolActivity('WebSearch'), 'web');
eq('WebFetch looks out', toolActivity('WebFetch'), 'web');
eq('a browser connector looks out', toolActivity('mcp__playwright__browser_navigate'), 'web');
eq('other connectors work', toolActivity('mcp__claude_ai_Gmail__get_thread'), 'work');
eq('unknown tool falls back to work', toolActivity('SomethingNew'), 'work');

eq('idle line', lineActivity(''), null);
eq('thinking', lineActivity('Thinking'), 'think');
eq('choosing a model thinks', lineActivity('Choosing a model'), 'think');
eq('writing a reply', lineActivity('Writing a reply'), 'write');
eq('waiting for an answer', lineActivity('Waiting for your answer'), 'wait');
eq('waiting for an OK', lineActivity('Waiting for your OK: Claude wants to run: ls'), 'wait');
eq('tool line by its name', lineActivity('Read: server/index.ts'), 'read');
eq('connector tool line', lineActivity('mcp__phosphor__ask_local: Summarize'), 'work');
eq('other status text works', lineActivity('Painting 4/8'), 'work');

// ---------- What the mascot does ----------

const now = 1_000_000;
const tab = (meta: Partial<TabState['meta']>, activity = '', items: Item[] = []): TabState =>
  ({ meta: { id: 't', title: 'x', busy: false, attention: false, createdAt: 0, ...meta }, activity, items, agents: [] }) as unknown as TabState;

eq('no tab: idle', sceneActivity(undefined, null, now), 'idle');
eq('idle tab', sceneActivity(tab({}), null, now), 'idle');
eq('busy, reading', sceneActivity(tab({ busy: true }, 'Read: a.ts'), null, now), 'read');
eq('busy, no line yet: thinking', sceneActivity(tab({ busy: true }), null, now), 'think');
eq('needs you wins', sceneActivity(tab({ busy: true, attention: true }, 'Edit: a.ts'), null, now), 'wait');
const failed: Item[] = [{ id: '1', kind: 'tool', name: 'Bash', detail: 'npm test', error: true }];
eq('a failed command being looked at', sceneActivity(tab({ busy: true }, 'Bash: npm test', failed), null, now), 'error');
eq('next step after the failure', sceneActivity(tab({ busy: true }, 'Read: a.ts', failed), null, now), 'read');
eq('turn just ended: cheer', sceneActivity(tab({}), { at: now - 1000, error: false }, now), 'done');
eq('turn just ended in an error', sceneActivity(tab({}), { at: now - 1000, error: true }, now), 'error');
eq('cheer is over', sceneActivity(tab({}), { at: now - DONE_MS - 1, error: false }, now), 'idle');
eq('error note ends a turn in error', endedInError([{ id: '1', kind: 'note', text: 'Error: boom' }]), true);
eq('done note is no error', endedInError([{ id: '1', kind: 'note', text: 'Done in 4s.' }]), false);

// ---------- Crew walking in and out ----------

const agent = (id: string, status: Agent['status'], startedAt = 0): Agent => ({ id, name: 'Explore', description: id, status, summary: '', lastTool: '', toolUses: 0, tokens: 0, startedAt });
const ids = (ws: Walker[]) => ws.map((w) => `${w.id}:${w.slot}:${w.phase}`);

let r = planCrew([], [agent('a', 'running', 1), agent('b', 'running', 2), agent('c', 'completed', 0)], now, 4, true);
eq('running crew walk in, finished ones never show', ids(r.walkers), ['a:0:enter', 'b:1:enter']);
r = planCrew(r.walkers, [agent('a', 'running', 1), agent('b', 'running', 2)], now + ENTER_MS, 4, true);
eq('after the walk they work', ids(r.walkers), ['a:0:work', 'b:1:work']);
r = planCrew(r.walkers, [agent('a', 'completed', 1), agent('b', 'running', 2), agent('d', 'running', 3)], now + ENTER_MS + 10, 4, true);
eq('a finished one leaves, its slot stays taken while it walks out; a new one takes the next', ids(r.walkers), ['a:0:leave', 'b:1:work', 'd:2:enter']);
eq('next change is the walk-in end', nextCrewChange(r.walkers), now + ENTER_MS + 10 + ENTER_MS);
r = planCrew(r.walkers, [agent('a', 'completed', 1), agent('b', 'running', 2), agent('d', 'running', 3), agent('e', 'running', 4)], now + ENTER_MS + 10 + LEAVE_MS, 4, true);
eq('gone after walking out; the free slot is reused', ids(r.walkers), ['e:0:enter', 'b:1:work', 'd:2:work']);

const many = Array.from({ length: 7 }, (_, i) => agent(`m${i}`, 'running', i));
r = planCrew([], many, now, 9, true);
eq(`at most ${MAX_CREW} on stage, the rest counted`, [r.walkers.length, r.extra], [MAX_CREW, 3]);
r = planCrew([], many, now, 2, true);
eq('a narrow stage holds fewer', [r.walkers.length, r.extra], [2, 5]);
r = planCrew([], [agent('a', 'running', 1)], now, 4, false);
eq('no walk-in on a tab switch or first paint', ids(r.walkers), ['a:0:work']);
r = planCrew(r.walkers, [agent('a', 'failed', 1)], now, 4, false);
eq('no walk-out without animation', ids(r.walkers), []);
r = planCrew([{ id: 'x', agent: agent('x', 'running'), slot: 0, phase: 'work', since: 0 }], [], now, 4, true);
eq('a helper no longer in the list is dropped', ids(r.walkers), []);
eq('slots by stage width', [crewSlots(40), crewSlots(90), crewSlots(131), crewSlots(400)], [0, 2, 4, 4]);

// ---------- The art ----------

const ACTS: Activity[] = ['idle', 'think', 'write', 'read', 'edit', 'work', 'shell', 'web', 'wait', 'done', 'error'];
for (const a of ACTS) {
  const an = mascotAnim(a);
  eq(`mascot ${a}: frames ${MASCOT_W}x${MASCOT_H}`, an.frames.every((g) => g.w === MASCOT_W && g.h === MASCOT_H && g.px.some((p) => p > 0)), true);
}
const sizes = new Set<string>();
for (const kind of ['scout', 'architect', 'engineer', 'librarian', 'crew'] as const)
  for (let look = 0; look < (kind === 'crew' ? TROUPE_LOOKS : 1); look++)
    for (const move of ['walk', 'work', 'completed', 'failed', 'stopped'] as const)
      for (const out of [false, true]) for (const g of troupeAnim(kind, look, move, out).frames) sizes.add(`${g.w}x${g.h}`);
eq('every crew frame is one size', [...sizes], [`${TROUPE_W}x${TROUPE_H}`]);
eq('room fits any width', [80, 131, 200].map((w) => roomAnim(w).frames[0].w === w && roomAnim(w).frames[0].h === ROOM_H), [true, true, true]);

// Every sprite row in the scene art is as wide as its part, and uses only known colors (engine.ts legend; troupe.ts
// also has its outfit placeholders A, D, P).
for (const f of ['mascot', 'troupe', 'room']) {
  const known = new Set(['.', '+', '#', '@', 'o', 'x', 'c', ...RAMPS.map((r) => r[0]), ...(f === 'troupe' ? ['A', 'D', 'P'] : [])]);
  const src = readFileSync(new URL(`../web/src/sprites/${f}.ts`, import.meta.url), 'utf8');
  const bad: string[] = [];
  for (const m of src.matchAll(/part`([^`]*)`/g)) {
    const rows = m[1].split('\n').map((x) => x.trim()).filter(Boolean);
    const line = src.slice(0, m.index).split('\n').length;
    if (rows.some((x) => x.length !== rows[0].length)) bad.push(`line ${line}: uneven rows`);
    const odd = [...new Set(rows.join(''))].filter((ch) => !known.has(ch));
    if (odd.length) bad.push(`line ${line}: unknown ${odd.join('')}`);
  }
  eq(`${f}.ts parts are even and use known colors`, bad, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
