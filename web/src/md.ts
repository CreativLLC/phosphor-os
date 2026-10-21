import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { fixLists } from './mdlists.ts';
import { toast } from './ui.ts';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Claude's markdown to safe HTML. Sanitized because this page can run commands on the PC.
export function renderMarkdown(text: string): string {
  const html = marked.parse(fixLists(text), { async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'video', 'audio'] });
}

// Put Claude's markdown into `body`, with a COPY button on every code block (shows on hover; always on touch).
export function setMarkdown(body: HTMLElement, text: string): void {
  body.innerHTML = renderMarkdown(text);
  for (const pre of body.querySelectorAll('pre')) {
    const box = document.createElement('div');
    box.className = 'code-box';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.innerHTML = COPY_ICON;
    btn.title = 'Copy';
    btn.setAttribute('aria-label', 'Copy');
    btn.onclick = () => void copyText((pre.querySelector('code') ?? pre).textContent ?? '', btn);
    pre.replaceWith(box);
    box.append(pre, btn);
  }
}

// Pixel-style icons in the text colour: two sheets (copy) and a tick (copied).
const svg = (d: string) =>
  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" shape-rendering="crispEdges" aria-hidden="true">${d}</svg>`;
const COPY_ICON = svg('<rect x="5.5" y="5.5" width="8" height="8"/><path d="M10.5 3.5V2.5H2.5V10.5H3.5"/>');
const DONE_ICON = svg('<path d="M2.5 8.5L6 12L13.5 4.5"/>');

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  const value = text.replace(/\n$/, ''); // marked ends code blocks with a newline: a paste would run the command
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // No clipboard API (plain http on another device): the old way.
    const area = document.createElement('textarea');
    area.value = value;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) return toast('Could not copy. Select the text instead.');
  }
  btn.innerHTML = DONE_ICON;
  setTimeout(() => (btn.innerHTML = COPY_ICON), 1500);
}
