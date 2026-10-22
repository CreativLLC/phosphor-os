// IDEAS: "do this later" notes in one markdown file (server/ideas.ts, web/src/ideas.ts). Any chat adds a line
// when the owner says "park this"; a weekly routine may add to Suggested. Format, one idea per line:
//   ## Parked
//   - [ ] 2026-10-21 · phosphor-os · the idea in one line
//   ## Suggested
//   - [ ] ...
// Ticked lines ("- [x]") and lines outside those two sections are not shown.

export type IdeaSection = 'parked' | 'suggested';
// line: the exact line in the file; it is the id (DROP removes that line).
export type Idea = { line: string; section: IdeaSection; date: string; project: string; text: string };
// GET /api/ideas. found: the file exists. POST /api/ideas/drop { lines } answers the same shape.
export type IdeasResponse = { file: string; found: boolean; ideas: Idea[] };

const ITEM = /^\s{0,3}[-*+]\s+(?:\[ \]\s+)?(.+?)\s*$/;
const DONE = /^\s{0,3}[-*+]\s+\[[xX]\]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIdeas(md: string): Idea[] {
  const out: Idea[] = [];
  let section: IdeaSection | null = null;
  for (const line of md.split(/\r?\n/)) {
    // Any heading ends a section; only ## Parked / ## Suggested (level 2 or lower) start one, not the # title.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const name = h[1].length > 1 ? h[2].trim().toLowerCase() : '';
      section = name.startsWith('parked') ? 'parked' : name.startsWith('suggested') ? 'suggested' : null;
      continue;
    }
    if (!section || DONE.test(line)) continue;
    const m = ITEM.exec(line);
    if (!m) continue;
    const parts = m[1].split(' · ');
    const dated = parts.length >= 3 && DATE.test(parts[0].trim());
    out.push({
      line,
      section,
      date: dated ? parts[0].trim() : '',
      project: dated ? parts[1].trim() : '',
      text: dated ? parts.slice(2).join(' · ').trim() : m[1],
    });
  }
  return out;
}

// The file without the given lines (each removed once; lines no longer there are skipped).
export function dropIdeas(md: string, lines: string[]): string {
  const left = new Map<string, number>();
  for (const l of lines) left.set(l, (left.get(l) ?? 0) + 1);
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  return md
    .split(/\r?\n/)
    .filter((l) => {
      const n = left.get(l);
      if (!n) return true;
      left.set(l, n - 1);
      return false;
    })
    .join(eol);
}

// The first message of the chat that does the chosen ideas.
export function ideasPrompt(ideas: Idea[], file: string): string {
  const list = ideas.map((i, n) => `${n + 1}. ${i.project ? `[${i.project}] ` : ''}${i.text}`).join('\n');
  return [
    `Do these parked ideas from ${file}:`,
    '',
    list,
    '',
    'Take them one at a time. Ask me first if one is unclear or needs a decision. When one is done, or I drop it, delete its line from that file.',
  ].join('\n');
}

// Weekly suggestions (server/ideasweekly.ts): the model's answer -> valid idea lines, dated `today`, at most `max`,
// none that repeat an idea already in the file (same text, case and spaces aside).
const SUGGESTION = /^\s*[-*]\s+(?:\[ \]\s+)?(?:\d{4}-\d{2}-\d{2}\s+·\s+)?([^·\n]{1,40}?)\s+·\s+([^·\n]{8,300})$/;
const same = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function pickSuggestions(raw: string, today: string, existing: Idea[], max = 5): string[] {
  const seen = new Set(existing.map((i) => same(i.text)));
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = SUGGESTION.exec(line);
    if (!m) continue;
    const project = m[1].trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (seen.has(same(text))) continue;
    seen.add(same(text));
    out.push(`- [ ] ${today} · ${project} · ${text}`);
    if (out.length >= max) break;
  }
  return out;
}

// The file with `lines` added at the end of its ## Suggested section (made at the end of the file if missing).
export function addSuggested(md: string, lines: string[]): string {
  if (!lines.length) return md;
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const rows = md.split(/\r?\n/);
  const start = rows.findIndex((l) => /^#{2,6}\s+suggested/i.test(l));
  if (start < 0) {
    while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
    return [...rows, '', '## Suggested', ...lines, ''].join(eol);
  }
  let end = rows.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  if (end < 0) end = rows.length;
  let at = end; // after the section's last non-blank line
  while (at > start + 1 && rows[at - 1].trim() === '') at--;
  rows.splice(at, 0, ...lines);
  return rows.join(eol);
}
