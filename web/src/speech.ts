import { marked, type Token, type Tokens } from 'marked';

// Claude's markdown reply -> plain sentences for the ship voice (shipvoice.ts). No DOM: tested in Node.
// Code blocks and tables are not read ("Code omitted." / "Table omitted."); long paths become their file
// name; links become their text. SHORT = the first two sentences of real text.

export type VoiceMode = 'short' | 'full';

export const CODE_OMITTED = 'Code omitted.';
export const TABLE_OMITTED = 'Table omitted.';
const SHORT_SENTENCES = 2;
const SHORT_MAX = 320;
const FULL_MAX = 2400; // about two and a half minutes of speech; the rest stays on screen
const MORE = 'The rest is on screen.';

// Paths: Windows (C:\a\b), home or absolute POSIX (/a/b, ~/a/b), or relative with two or more slashes (a/b/c.ts).
const PATH = /(?:[A-Za-z]:[\\/]|\\\\|~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:[\\/][\w.@+-]+){2,}[\\/]?|[A-Za-z]:[\\/][\w.@+-]+/g;
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/g;

function fileName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function clean(text: string): string {
  return text
    .replace(URL_RE, 'link')
    .replace(PATH, fileName)
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
    .replace(/\betc\./gi, 'et cetera')
    .replace(/\bvs\./gi, 'versus')
    .replace(/\s*(?:->|→|=>)\s*/g, ' to ')
    .replace(/[*_`#|~<>[\]{}▸▼▲◼■●○✓✔✗✘•]/g, ' ');
}

function inline(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        out += 'tokens' in t && t.tokens ? inline(t.tokens) : clean(t.text);
        break;
      case 'escape':
        out += clean(t.text);
        break;
      case 'strong':
      case 'em':
      case 'del':
        out += inline((t as Tokens.Strong).tokens);
        break;
      case 'codespan': {
        const code = (t as Tokens.Codespan).text.trim();
        // Short names read fine ("setInterval", "npm start"); long code does not. A path in quotes is still a path.
        const path = !/\s/.test(code) && code.replace(PATH, '') === '';
        out += path || (code.length <= 40 && !/[\n;{}()=]/.test(code)) ? clean(code) : ' code ';
        break;
      }
      case 'link': {
        const l = t as Tokens.Link;
        const label = inline(l.tokens).trim();
        out += !label || label === l.href || /^https?:/.test(label) ? 'link' : label;
        break;
      }
      case 'br':
        out += ' ';
        break;
      default:
        break; // images, html
    }
  }
  return out;
}

// End a block with a stop, so list items and headings are read as their own sentences.
function stop(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?:;]$/.test(t) ? t.replace(/[:;]$/, '.') : `${t}.`;
}

function blocks(tokens: Token[], out: string[]): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'code':
        if (out[out.length - 1] !== CODE_OMITTED) out.push(CODE_OMITTED);
        break;
      case 'table':
        if (out[out.length - 1] !== TABLE_OMITTED) out.push(TABLE_OMITTED);
        break;
      case 'heading':
      case 'paragraph':
        out.push(stop(inline((t as Tokens.Paragraph).tokens)));
        break;
      case 'text':
        out.push(stop('tokens' in t && t.tokens ? inline(t.tokens) : clean(t.text)));
        break;
      case 'list':
        for (const item of (t as Tokens.List).items) blocks(item.tokens, out);
        break;
      case 'blockquote':
        blocks((t as Tokens.Blockquote).tokens, out);
        break;
      default:
        break; // space, hr, html, def
    }
  }
}

// Split into sentences. Decimals ("1.5") and file names ("boot.ts") have no space after the dot, so they stay whole.
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

export function speakable(md: string, mode: VoiceMode): string {
  const out: string[] = [];
  blocks(marked.lexer(md ?? ''), out);
  const all = sentences(out.filter(Boolean).join(' '));
  if (!all.length) return '';
  if (mode === 'short') {
    const real = all.filter((s) => s !== CODE_OMITTED && s !== TABLE_OMITTED);
    const pick = (real.length ? real : all).slice(0, SHORT_SENTENCES).join(' ');
    return pick.length > SHORT_MAX ? `${pick.slice(0, pick.lastIndexOf(' ', SHORT_MAX))}.` : pick;
  }
  let text = '';
  for (const s of all) {
    if (text.length + s.length > FULL_MAX) return `${text} ${MORE}`.trim();
    text = text ? `${text} ${s}` : s;
  }
  return text;
}

// Chrome cuts off one long utterance after about 15 s, so the voice speaks in short pieces.
export function chunks(text: string, max = 200): string[] {
  const out: string[] = [];
  let cur = '';
  for (const s of sentences(text)) {
    if (cur && cur.length + s.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    if (s.length > max) {
      // One very long sentence: break at word gaps.
      let rest = s;
      while (rest.length > max) {
        const cut = rest.lastIndexOf(' ', max);
        const at = cut > 40 ? cut : max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}
