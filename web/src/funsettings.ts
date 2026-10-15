// Settings for the fun pack (ship voice, game mode), kept in this browser (localStorage).
// Separate key from settings.ts on purpose: each device keeps its own (the phone and the PC must not both talk).

export type FunSettings = {
  voiceOut: 'off' | 'short' | 'full'; // read Claude's finished replies aloud
  voice: string; // voiceURI picked in SETTINGS; '' = best one found
  chime: boolean; // short chime before speaking
  game: boolean; // GAME MODE (gamemode.ts)
};

const KEY = 'phosphor.fun';

let current: FunSettings = load();
const listeners = new Set<(s: FunSettings, changed: keyof FunSettings) => void>();

export function funSettings(): FunSettings {
  return current;
}

export function onFun(fn: (s: FunSettings, changed: keyof FunSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setFun<K extends keyof FunSettings>(key: K, value: FunSettings[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage blocked: works until reload */
  }
  for (const fn of listeners) fn(current, key);
}

function load(): FunSettings {
  let s: Partial<FunSettings> = {};
  try {
    s = (JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<FunSettings>) ?? {};
  } catch {
    /* blocked or bad JSON: defaults */
  }
  return {
    voiceOut: s.voiceOut === 'short' || s.voiceOut === 'full' ? s.voiceOut : 'off',
    voice: typeof s.voice === 'string' ? s.voice : '',
    chime: s.chime !== false,
    game: s.game === true,
  };
}
