import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptOldEnv } from '../shared/names.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const WEB_DIST = join(ROOT, 'web', 'dist');
mkdirSync(DATA_DIR, { recursive: true });

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
adoptOldEnv(); // .env files from before the rename say RETRO_*

// First run: make a password and save it to .env so the owner can read or change it.
let newPassword = false;
if (!process.env.PHOSPHOR_PASSWORD) {
  process.env.PHOSPHOR_PASSWORD = randomBytes(9).toString('base64url');
  appendFileSync(envFile, `PHOSPHOR_PASSWORD=${process.env.PHOSPHOR_PASSWORD}\n`);
  newPassword = true;
}

export const config = {
  port: Number(process.env.PHOSPHOR_PORT || 7337),
  password: process.env.PHOSPHOR_PASSWORD,
  newPassword,
  cwd: resolve(process.env.PHOSPHOR_CWD || homedir()),
  // Localhost only. The phone reaches it through `tailscale serve` (private HTTPS on the tailnet).
  host: '127.0.0.1',
};

// Optional local models (scripts/setup-local-model.sh): one llama.cpp server that answers in Claude's API format and
// loads whichever model a request names. PHOSPHOR_LOCAL_MODELS="name=label,name=label"; the first is the picker value
// "local" (saved tabs keep working), the others "local:<name>". Without it, the single PHOSPHOR_LOCAL_MODEL/_LABEL pair.
const localUrl = process.env.PHOSPHOR_LOCAL_URL;
// PHOSPHOR_LOCAL_MORE_MODELS: entries another installer adds (scripts/setup-strata.sh), so re-running
// setup-local-model.sh, which rewrites PHOSPHOR_LOCAL_MODELS, keeps them.
const localList = [
  process.env.PHOSPHOR_LOCAL_MODELS || (process.env.PHOSPHOR_LOCAL_MODEL ? `${process.env.PHOSPHOR_LOCAL_MODEL}=${process.env.PHOSPHOR_LOCAL_LABEL ?? ''}` : ''),
  process.env.PHOSPHOR_LOCAL_MORE_MODELS ?? '',
]
  .join(',')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x, i) => {
    const [name, ...label] = x.split('=');
    return { value: i === 0 ? 'local' : `local:${name.trim()}`, name: name.trim(), label: label.join('=').trim() || `${name.trim()} (local)` };
  });
// "name=value,name=value" -> { name: value }.
const nameMap = (v?: string): Record<string, string> =>
  Object.fromEntries(
    (v ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.includes('='))
      .map((x) => [x.slice(0, x.indexOf('=')).trim(), x.slice(x.indexOf('=') + 1).trim()]),
  );
// A model can live on its own server instead of the router (scripts/setup-strata.sh): PHOSPHOR_LOCAL_URLS names that
// server, PHOSPHOR_LOCAL_UNITS the systemd user unit that starts it, PHOSPHOR_LOCAL_CONTEXTS its context window.
export const localModel =
  localUrl && localList.length
    ? {
        url: localUrl,
        models: localList,
        key: process.env.PHOSPHOR_LOCAL_KEY || 'local',
        context: Number(process.env.PHOSPHOR_LOCAL_CONTEXT) || 32768,
        urls: nameMap(process.env.PHOSPHOR_LOCAL_URLS),
        units: nameMap(process.env.PHOSPHOR_LOCAL_UNITS),
        contexts: Object.fromEntries(Object.entries(nameMap(process.env.PHOSPHOR_LOCAL_CONTEXTS)).map(([k, v]) => [k, Number(v) || 32768])),
      }
    : undefined;
// The configured local model a picker value stands for ("local", "local:<name>", also "local:<first name>"), if any.
export const localChoice = (value?: string) => localModel?.models.find((m) => m.value === value) ?? localModel?.models.find((m) => `local:${m.name}` === value);
delete process.env.PHOSPHOR_LOCAL_KEY;

// Optional local image model (scripts/setup-image-model.sh): a stable-diffusion.cpp server the app starts with its
// systemd user unit when a picture is asked for, and stops when idle. EDIT=1: it can change an attached picture.
// TURBO: a LoRA file in the engine's LoRA folder for the default 8-step mode (--best skips it). DIR: where pictures are saved.
const imageUrl = process.env.PHOSPHOR_IMAGE_URL;
export const imageModel = imageUrl
  ? {
      url: imageUrl,
      label: process.env.PHOSPHOR_IMAGE_LABEL || 'Image (local)',
      unit: process.env.PHOSPHOR_IMAGE_UNIT || '',
      edit: process.env.PHOSPHOR_IMAGE_EDIT === '1',
      turbo: process.env.PHOSPHOR_IMAGE_TURBO || '',
      dir: resolve(process.env.PHOSPHOR_IMAGE_DIR || join(DATA_DIR, 'images')),
      idleMs: (Number(process.env.PHOSPHOR_IMAGE_IDLE_SECONDS) || 300) * 1000,
    }
  : undefined;

// Keep the password out of the environment, so the Claude processes this server starts
// (and every command they run) do not inherit it.
delete process.env.PHOSPHOR_PASSWORD;
delete process.env.RETRO_PASSWORD;
