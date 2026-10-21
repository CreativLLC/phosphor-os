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
