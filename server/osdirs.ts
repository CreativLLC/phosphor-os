import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { appFolder } from '../shared/names.mjs';

// Per-PC folders that must stay out of the synced project folder (models, runtimes), by OS.
// Windows: %LOCALAPPDATA%\PhosphorOS    Linux: ${XDG_DATA_HOME:-~/.local/share}/PhosphorOS
// (or the RetroClaude folder of an install from before the rename, while it is the only one: shared/names.mjs)
// The arguments are only there so tests can ask for the other OS.
export function appDataDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform === 'win32') return appFolder(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), win32.join, exists);
  // The XDG spec says to ignore a relative XDG_DATA_HOME.
  const data = env.XDG_DATA_HOME?.startsWith('/') ? env.XDG_DATA_HOME : posix.join(home, '.local', 'share');
  return appFolder(data, posix.join, exists);
}

export function voiceDir(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.PHOSPHOR_VOICE_DIR) return env.PHOSPHOR_VOICE_DIR;
  return (platform === 'win32' ? win32 : posix).join(appDataDir(platform, env, home), 'voice');
}

// What to run to install the voice engine on this OS (shown when DICTATE finds no engine).
export function voiceSetupCommand(platform: string = process.platform): string {
  return platform === 'win32' ? 'powershell -ExecutionPolicy Bypass -File scripts\\setup-voice.ps1' : 'bash scripts/setup-voice.sh';
}
