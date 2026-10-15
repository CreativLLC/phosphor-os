import { funSettings, onFun, setFun, type FunSettings } from './funsettings.ts';
import { getSettings, setSetting, type Settings } from './settings.ts';
import { repaintAll } from './sprites/engine.ts';

// GAME MODE: the app goes quiet so a game gets the whole PC. CRT effects, voice out and sounds
// off; sprites and CSS animations stop (html[data-game="on"], fun.css); the usage meter checks every
// 30 minutes instead of 5 (usage.ts). Turning it off puts back what it changed, except settings you
// changed yourself while it was on.

const BEFORE_KEY = 'phosphor.fun.beforeGame';
type Before = { crt: Settings['crt']; sound: boolean; voiceOut: FunSettings['voiceOut'] };

export function gameMode(): boolean {
  return funSettings().game;
}

export function setGameMode(on: boolean): void {
  if (on === funSettings().game) return;
  if (on) {
    const before: Before = { crt: getSettings().crt, sound: getSettings().sound, voiceOut: funSettings().voiceOut };
    try {
      localStorage.setItem(BEFORE_KEY, JSON.stringify(before));
    } catch {
      /* storage blocked: turning it off then keeps the quiet settings */
    }
    setFun('game', true);
    setSetting('crt', 'off');
    setSetting('sound', false);
    setFun('voiceOut', 'off');
  } else {
    let before: Partial<Before> = {};
    try {
      before = (JSON.parse(localStorage.getItem(BEFORE_KEY) || '{}') as Partial<Before>) ?? {};
      localStorage.removeItem(BEFORE_KEY);
    } catch {
      /* nothing saved */
    }
    setFun('game', false);
    if (before.crt && getSettings().crt === 'off') setSetting('crt', before.crt);
    if (typeof before.sound === 'boolean' && getSettings().sound === false) setSetting('sound', before.sound);
    if (before.voiceOut && funSettings().voiceOut === 'off') setFun('voiceOut', before.voiceOut);
  }
}

export function toggleGameMode(): void {
  setGameMode(!funSettings().game);
}

function apply(): void {
  const d = document.documentElement;
  if (funSettings().game) d.dataset.game = 'on';
  else delete d.dataset.game;
  repaintAll(); // sprites/engine.ts reads data-game: still frames, clock stopped
}

export function initGameMode(): void {
  apply();
  onFun((_, changed) => {
    if (changed === 'game') apply();
  });
}
