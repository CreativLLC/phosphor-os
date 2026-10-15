import './fun.css';
import { funSettings, setFun } from './funsettings.ts';
import { initGameMode, toggleGameMode } from './gamemode.ts';
import { initShipVoice, stopVoice } from './shipvoice.ts';

// The fun pack: ship voice (shipvoice.ts), GAME MODE (gamemode.ts). The screensaver is the OS's, not the app's (saver.ts).
// Boot checks are started by boot.ts (bootchecks.ts); SETTINGS rows come from funsection.ts.
// main.ts calls startFun() once.

export function startFun(): void {
  initGameMode();
  initShipVoice();
}

// Launcher entries (same shape as launcher.ts LauncherCommand), for the lead to pass to addLauncherCommands().
export function funCommands(): { id: string; label: string; hint?: string; keywords?: string[]; run(): void }[] {
  const order = ['off', 'short', 'full'] as const;
  return [
    { id: 'fun-game', label: 'GAME MODE', hint: 'On or off: effects, sounds and voice off', keywords: ['game', 'gaming', 'quiet', 'fps', 'performance'], run: toggleGameMode },
    {
      id: 'fun-voice',
      label: 'VOICE OUT',
      hint: 'Next: off, short, full',
      keywords: ['voice', 'speak', 'read aloud', 'tts'],
      run: () => setFun('voiceOut', order[(order.indexOf(funSettings().voiceOut) + 1) % order.length]),
    },
    { id: 'fun-voice-stop', label: 'STOP VOICE', keywords: ['quiet', 'silence', 'shut up'], run: stopVoice },
  ];
}

export { toggleGameMode };
