// DICTATE in any app, the desktop app's part (shell/main.mjs mounts it). The take itself is the Omarchy pack's
// (os/omarchy/clock/phosphor-dictate, Linux); here only the one setting SETTINGS > VOICE changes: CLEAN UP for the
// words that go into other apps, kept in ~/.config/phosphor-os/dictate.json, which the take reads at each stop.
// Bridge (preload.cjs): invoke dictate:get -> DictateInfo | null (null: not Linux, or not asked by the app's own
// page); invoke dictate:set { cleanup } -> DictateInfo. DictateInfo = { where: 'pack' | 'none', cleanup }.

import { ipcMain } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSettings, settingsFile } from '../shared/dictate.mjs';

const LINUX = process.platform === 'linux';

// opts: { isApp }
export function mountDictate({ isApp }) {
  const file = settingsFile(homedir());
  const settings = () => {
    try {
      return readSettings(readFileSync(file, 'utf8'));
    } catch {
      return readSettings('');
    }
  };
  // The pack's take sits next to the clock plugin's other files; without it there is nothing to set.
  const packInstalled = () => existsSync(join(homedir(), '.config', 'omarchy', 'plugins', 'phosphor-os.clock', 'phosphor-dictate'));
  const info = () => ({ where: packInstalled() ? 'pack' : 'none', cleanup: settings().cleanup });

  const fromApp = (e) => LINUX && isApp(e.senderFrame?.url ?? '');
  ipcMain.handle('dictate:get', (e) => (fromApp(e) ? info() : null));
  ipcMain.handle('dictate:set', (e, patch) => {
    if (!fromApp(e) || !patch || typeof patch !== 'object') return null;
    if (typeof patch.cleanup === 'boolean') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ cleanup: patch.cleanup }, null, 2)}\n`);
    }
    return info();
  });
}
