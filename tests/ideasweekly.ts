// IDEAS weekly suggestions: answer parsing, adding to the file, note digests, which notes count, when it runs.
// No model call.   npx tsx tests/ideasweekly.ts

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSuggested, parseIdeas, pickSuggestions } from '../shared/ideas.ts';
import { isDue, noteDigest, weekNotes } from '../server/ideasweekly.ts';

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

const existing = parseIdeas('## Parked\n- [ ] 2026-10-20 · app · Add dark mode to settings\n');
const raw = [
  'Here are my ideas:',
  '- [ ] 2026-10-23 · Phosphor OS · Add a weekly check that every project still builds',
  '- [ ] 2026-10-01 · brain · Wrong date gets today instead',
  '- 2026-10-23 · app · add  dark   MODE to settings',
  '- [ ] 2026-10-23 · x · short',
  '* youtube · Batch the voice tests into one script run',
  'NONE',
].join('\n');
const got = pickSuggestions(raw, '2026-10-23', existing);
eq('valid lines, dated today, deduped', got, [
  '- [ ] 2026-10-23 · phosphor-os · Add a weekly check that every project still builds',
  '- [ ] 2026-10-23 · brain · Wrong date gets today instead',
  '- [ ] 2026-10-23 · youtube · Batch the voice tests into one script run',
]);
eq('NONE gives nothing', pickSuggestions('NONE', '2026-10-23', []), []);
eq('max 5', pickSuggestions(Array.from({ length: 8 }, (_, i) => `- [ ] 2026-10-23 · p · idea number ${i} is long enough`).join('\n'), '2026-10-23', []).length, 5);
eq('repeats inside one answer', pickSuggestions('- p · same idea text here\n- q · Same idea  text here', 'd', []).length, 1);

const file = '# Parked ideas\n\nintro\n\n## Parked\n- [ ] a · b · c\n\n## Suggested\n- [ ] old · x · y\n\n';
eq('add at end of Suggested', addSuggested(file, ['- [ ] new']), '# Parked ideas\n\nintro\n\n## Parked\n- [ ] a · b · c\n\n## Suggested\n- [ ] old · x · y\n- [ ] new\n\n');
eq('empty Suggested', addSuggested('## Parked\n\n## Suggested\n', ['- [ ] n']), '## Parked\n\n## Suggested\n- [ ] n\n');
eq('Suggested before another section', addSuggested('## Suggested\n- [ ] o\n\n## Notes\nx', ['- [ ] n']), '## Suggested\n- [ ] o\n- [ ] n\n\n## Notes\nx');
eq('no Suggested section', addSuggested('## Parked\n- [ ] p\n\n', ['- [ ] n']), '## Parked\n- [ ] p\n\n## Suggested\n- [ ] n\n');
eq('nothing to add', addSuggested(file, []), file);
eq('added lines parse as suggested', parseIdeas(addSuggested(file, ['- [ ] 2026-10-23 · p · fresh idea'])).filter((i) => i.section === 'suggested').map((i) => i.text), ['old · x · y', 'fresh idea']);

const note = '---\ntype: Source-candidate\ntitle: Cache clock built\n---\n\n# Ignored heading\n\n## What happened\n- built it\n\n## People/orgs mentioned\n- nobody\n\n## Next / open questions\n- restart\n';
const dg = noteDigest(note);
eq('digest title', dg.startsWith('# Cache clock built\n'), true);
eq('digest keeps what happened + next', dg.includes('built it') && dg.includes('restart'), true);
eq('digest drops other sections', dg.includes('nobody'), false);
eq('digest cut', noteDigest('# T\n' + 'x'.repeat(5000), 100).length < 120, true);
eq('digest of a plain note', noteDigest('just some text'), 'just some text');

const dir = mkdtempSync(join(tmpdir(), 'ideasweekly-'));
try {
  const now = Date.parse('2026-10-23T08:00:00');
  writeFileSync(join(dir, 'work-2026-10-22-a.md'), '## What happened\n- newest');
  writeFileSync(join(dir, 'work-2026-10-17-b.md'), '## What happened\n- six days old');
  writeFileSync(join(dir, 'work-2026-10-10-c.md'), '## What happened\n- too old');
  writeFileSync(join(dir, 'notes.md'), 'no date');
  writeFileSync(join(dir, 'work-2026-10-21-d.txt'), 'not markdown');
  const notes = await weekNotes([dir, join(dir, 'missing')], now);
  eq('week notes, newest first', notes.map(([n]) => n), ['work-2026-10-22-a.md', 'work-2026-10-17-b.md']);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const fri = (h: number) => new Date(2026, 9, 23, h).getTime(); // Fri Oct 23 2026
const D = 86_400_000;
eq('first Friday, morning', isDue(fri(8), 0), true);
eq('first Friday, too early', isDue(fri(6), 0), false);
eq('not Friday, never run', isDue(fri(8) - D, 0), false);
eq('ran last Friday', isDue(fri(8), fri(8) - 7 * D), true);
eq('ran this morning', isDue(fri(10), fri(8)), false);
eq('missed Friday: Saturday after 8 days', isDue(fri(9) + D, fri(9) - 7 * D), true);
eq('Thursday 6 days on: wait', isDue(fri(9) - D, fri(9) - 7 * D), false);
eq('failed 2 h ago: wait', isDue(fri(10), fri(8) - 7 * D, fri(8)), false);
eq('failed 7 h ago: try again', isDue(fri(15), fri(8) - 7 * D, fri(8)), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
