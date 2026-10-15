import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { button, el, toast } from './ui.ts';

// SETTINGS > SECURITY: add fingerprint login for this device, change the password.

export function securitySection(): HTMLElement {
  const box = el('div', 'set-security');
  box.append(el('div', 'set-label', 'SECURITY'));
  const row = el('div', 'seg');

  if (browserSupportsWebAuthn() && isSecureContext) {
    row.append(
      button('ADD FINGERPRINT LOGIN', () => void addFingerprint(), 'set-wide'),
    );
  }
  const form = passwordForm();
  row.append(
    button('CHANGE PASSWORD', () => {
      form.hidden = !form.hidden;
      if (!form.hidden) (form.querySelector('input') as HTMLInputElement).focus();
    }, 'set-wide'),
  );
  box.append(row, form);
  return box;
}

async function addFingerprint(): Promise<void> {
  try {
    const r = await fetch('/api/passkey/register/options', { method: 'POST' });
    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Not available.');
    const answer = await startRegistration({ optionsJSON: await r.json() });
    const v = await fetch('/api/passkey/register/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer) });
    if (!v.ok) throw new Error(((await v.json()) as { error?: string }).error ?? 'Not saved.');
    toast('Fingerprint login added for this device.');
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'NotAllowedError' ? 'Cancelled.' : e.message) : 'Failed.';
    toast(`Fingerprint login: ${msg}`);
  }
}

function passwordForm(): HTMLFormElement {
  const form = el('form', 'set-pw');
  form.hidden = true;
  const cur = el('input');
  cur.type = 'password';
  cur.placeholder = 'Current password';
  cur.autocomplete = 'current-password';
  const next = el('input');
  next.type = 'password';
  next.placeholder = 'New password';
  next.autocomplete = 'new-password';
  const again = el('input');
  again.type = 'password';
  again.placeholder = 'New password again';
  again.autocomplete = 'new-password';
  const save = el('button', 'primary', 'SAVE');
  save.type = 'submit';
  form.append(cur, next, again, save, el('div', 'set-foot', 'Other devices get logged out. This one stays in.'));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (next.value !== again.value) return toast('The new passwords do not match.');
    const r = await fetch('/api/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: cur.value, next: next.value }) }).catch(() => null);
    const data = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : { error: 'Server not reachable.' };
    if (!r?.ok) {
      toast(r?.status === 404 ? 'The server update has not loaded yet. Try again in a minute.' : `Password: ${data.error ?? 'failed'}`);
      return;
    }
    form.reset();
    form.hidden = true;
    toast('Password changed.');
  };
  return form;
}
