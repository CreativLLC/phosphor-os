import './boot.css';
import { startLcarsBoot } from './boot-lcars.ts';
import { currentTheme } from './themes.ts';
import { bootCheckLines, bootChecks, onBootCheck, reportBootChecks } from './bootchecks.ts';

// Short boot screen, once per browser session. The inline script in index.html decides:
// it adds html.booting (hides the app) unless this session already booted or the user
// prefers reduced motion. Tap, click or any key skips it. Total time is about 1.5s.

const TYPE_MS = 1050;
const HOLD_MS = 250;
const FADE_MS = 200;

function script(): string {
  const phosphor = document.documentElement.dataset.phosphor === 'green' ? 'GREEN' : 'AMBER';
  return [
    'PHOSPHOR-OS  //  CLAUDE 6000 SERIES',
    'SHIP INTERFACE SYSTEM  REV 2.6',
    '',
    'MEMORY BANKS ........... OK',
    `PHOSPHOR ............... ${phosphor}`,
    ...bootCheckLines(), // real checks, filled in as they arrive (bootchecks.ts)
    'AGENT BAY .............. READY',
    'PRIORITY CHANNEL ....... OPEN',
    '',
    'CLAUDE 6000 ONLINE. AWAITING INSTRUCTIONS.',
  ].join('\n');
}

export function startBoot(): void {
  const html = document.documentElement;
  if (!html.classList.contains('booting')) return;
  try {
    sessionStorage.setItem('phosphor.booted', '1');
  } catch {
    /* storage blocked: it may show again next load, which is fine */
  }
  if (currentTheme().boot === 'lcars') {
    // Same real checks behind the LCARS boot: anything WARN or FAIL shows as one toast.
    bootChecks();
    startLcarsBoot(html);
    reportBootChecks();
    return;
  }

  const box = document.createElement('div');
  box.id = 'boot';
  box.setAttribute('aria-hidden', 'true');
  const pre = document.createElement('pre');
  const typed = document.createTextNode('');
  const cursor = document.createElement('span');
  cursor.className = 'boot-cursor';
  pre.append(typed, cursor);
  const hint = document.createElement('div');
  hint.className = 'boot-skip';
  hint.textContent = 'TAP OR PRESS ANY KEY TO SKIP';
  box.append(pre, hint);
  document.body.append(box);

  let text = script();
  onBootCheck(() => (text = script()));
  const t0 = performance.now();
  let raf = 0;
  let ended = false;

  const end = () => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    clearTimeout(safety);
    window.removeEventListener('pointerdown', skip, true);
    window.removeEventListener('keydown', skip, true);
    html.classList.remove('booting');
    box.classList.add('out');
    setTimeout(() => box.remove(), FADE_MS + 50);
    reportBootChecks();
  };
  const skip = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    typed.data = text;
    end();
  };
  const frame = (now: number) => {
    const t = now - t0;
    typed.data = text.slice(0, Math.ceil((text.length * t) / TYPE_MS));
    if (t >= TYPE_MS + HOLD_MS) end();
    else raf = requestAnimationFrame(frame);
  };
  // If frames stall (background tab), never leave the app hidden.
  const safety = setTimeout(end, TYPE_MS + HOLD_MS + 600);

  window.addEventListener('pointerdown', skip, true);
  window.addEventListener('keydown', skip, true);
  raf = requestAnimationFrame(frame);
}
