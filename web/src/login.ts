import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { currentTheme } from './themes.ts';

// Login page: password form (plain HTML post) plus fingerprint login when one is set up for this address.

// Theme CSS comes with themes.ts; the inline script in login.html already picked the theme.
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', currentTheme().screen);

const wrong = document.querySelector('.wrong') as HTMLElement;
const fp = document.getElementById('fp') as HTMLButtonElement;
const fpMsg = document.getElementById('fp-msg') as HTMLElement;

if (location.search.includes('wrong=1')) wrong.hidden = false;

async function fingerprint(): Promise<void> {
  fpMsg.hidden = true;
  try {
    const r = await fetch('/api/passkey/login/options', { method: 'POST' });
    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Not available.');
    const answer = await startAuthentication({ optionsJSON: await r.json() });
    const v = await fetch('/api/passkey/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer) });
    if (!v.ok) throw new Error(((await v.json()) as { error?: string }).error ?? 'Not confirmed.');
    location.href = '/';
  } catch (e) {
    fpMsg.textContent = `FINGERPRINT LOGIN DID NOT WORK. ${e instanceof Error && e.name !== 'NotAllowedError' ? e.message : 'Tap the button to try again, or use the password.'}`;
    fpMsg.hidden = false;
  }
}

async function init(): Promise<void> {
  if (!browserSupportsWebAuthn() || !isSecureContext) return;
  try {
    const s = (await (await fetch('/api/passkey/status', { method: 'POST' })).json()) as { count?: number };
    if (!s.count) return;
  } catch {
    return;
  }
  fp.hidden = false;
  fp.onclick = () => void fingerprint();
  void fingerprint(); // ask right away; the button is there if the phone wants a tap first
}

void init();

// Same service worker as the app page, so the home-screen app is installable from here too.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
