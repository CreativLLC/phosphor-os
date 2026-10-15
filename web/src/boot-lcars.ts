// LCARS boot screen (boot.ts hands over when the theme's boot is 'lcars'). Same rules as the terminal one:
// once per browser session, about 1.5 s, any tap or key skips. The frame and the status rows come in on a
// schedule set in CSS (themes/lcars.css: --d = delay in ms); only opacity and transform animate.

const TOTAL_MS = 1500;
const FADE_MS = 200;

const ROWS: [label: string, value: string][] = [
  ['MEMORY BANKS', 'OK'],
  ['DISPLAY', 'PANEL'],
  ['LINK TO HOST', 'OK'],
  ['AGENT BAY', 'READY'],
  ['PRIORITY CHANNEL', 'OPEN'],
];

function div(cls: string, text?: string, delay?: number): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text) d.textContent = text;
  if (delay !== undefined) d.style.setProperty('--d', String(delay));
  return d;
}

export function startLcarsBoot(html: HTMLElement): void {
  const box = div('lc-boot');
  box.id = 'boot';
  box.setAttribute('aria-hidden', 'true');

  // Frame: elbow, top bar segments, side column blocks with static numbers.
  const top = div('lcb-top');
  top.append(div('lcb-seg lcb-a', '', 60), div('lcb-seg lcb-b', '', 100), div('lcb-seg lcb-c', '', 140), div('lcb-seg lcb-fill', '', 180), div('lcb-cap', '', 220));
  const side = div('lcb-side');
  side.append(div('lcb-blk lcb-b', '03-1185', 120), div('lcb-blk lcb-c', '22-0406', 180), div('lcb-blk lcb-d', '07-3341', 240), div('lcb-blk lcb-fill', '', 300));
  const main = div('lcb-main');
  main.append(div('lcb-title', 'PHOSPHOR-OS', 260), div('lcb-sub', 'CLAUDE 6000 SERIES  /  INTERFACE REV 2.6', 340));
  const rows = div('lcb-rows');
  ROWS.forEach(([label, value], i) => {
    const r = div('lcb-row', undefined, 460 + i * 130);
    r.append(div('lcb-key'), div('lcb-label', label), div('lcb-val', value));
    rows.append(r);
  });
  main.append(rows, div('lcb-ready', 'CLAUDE 6000 ONLINE. AWAITING INSTRUCTIONS.', 1150));
  const frame = div('lcb-frame');
  frame.append(div('lcb-elbow', '', 0), top, side, main);
  box.append(frame, div('boot-skip', 'TAP OR PRESS ANY KEY TO SKIP'));
  document.body.append(box);

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    window.removeEventListener('pointerdown', skip, true);
    window.removeEventListener('keydown', skip, true);
    html.classList.remove('booting');
    box.classList.add('out');
    setTimeout(() => box.remove(), FADE_MS + 50);
  };
  const skip = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    end();
  };
  const timer = setTimeout(end, TOTAL_MS);
  window.addEventListener('pointerdown', skip, true);
  window.addEventListener('keydown', skip, true);
}
