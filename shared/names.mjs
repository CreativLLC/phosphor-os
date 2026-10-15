// The app was called Retro Claude until 2026-10-12. Installs made under that name keep working through these
// helpers (plain JavaScript, so the desktop app and the scripts can use them too, not only the server):
// - Settings are PHOSPHOR_* (in .env or the environment). The old RETRO_* name still counts when the new one is
//   not set.
// - The per-PC folder is PhosphorOS. An old RetroClaude folder is used while it is the only one there
//   (scripts/migrate-from-retro-claude.sh moves it on Linux; docs/MIGRATE.md).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Copies each RETRO_X into PHOSPHOR_X when PHOSPHOR_X is not set, so the rest of the code reads PHOSPHOR_* only.
export function adoptOldEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('RETRO_')) continue;
    const name = `PHOSPHOR_${key.slice('RETRO_'.length)}`;
    if (!env[name]) env[name] = env[key];
  }
  return env;
}

// One setting from the text of a .env file: PHOSPHOR_<key>, else RETRO_<key>. The last line wins.
export function envFileValue(text, key) {
  const get = (name) =>
    [...text.matchAll(new RegExp(`^\\s*${name}\\s*=(.*)$`, 'gm'))].at(-1)?.[1].trim().replace(/^"(.*)"$/, '$1') ?? '';
  return get(`PHOSPHOR_${key}`) || get(`RETRO_${key}`);
}

// The app's per-PC folder inside `parent`. (pathJoin and exists: only for tests of the other OS.)
export function appFolder(parent, pathJoin = join, exists = existsSync) {
  const now = pathJoin(parent, 'PhosphorOS');
  const old = pathJoin(parent, 'RetroClaude');
  return !exists(now) && exists(old) ? old : now;
}
