import { button, el } from './ui.ts';

// Themed box to add, change or remove a program-bar site (name and address are the owner's to edit).
// Resolves with the fields, 'remove', or null for CANCEL / Esc.

export type SiteFields = { name: string; url: string };

// nameOnly: an app button (Firefox, Discord): only its name is the owner's to change here.
export function siteBox(heading: string, start: SiteFields, canRemove: boolean, nameOnly = false): Promise<SiteFields | 'remove' | null> {
  return new Promise((resolve) => {
    const d = el('dialog', 'site-box');
    const form = el('form', 'site-form');
    const name = field('NAME', start.name, 'Discord');
    name.input.maxLength = 24; // the shell keeps 24
    const url = field('ADDRESS', start.url, 'discord.com/app');
    url.input.spellcheck = false;
    const err = el('p', 'site-err');
    err.hidden = true;
    form.append(name.row, url.row, err);
    if (nameOnly) url.row.style.display = 'none';

    const done = (v: SiteFields | 'remove' | null) => {
      d.close();
      d.remove();
      resolve(v);
    };
    const fail = (text: string, input: HTMLInputElement) => {
      err.textContent = text;
      err.hidden = false;
      input.focus();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const n = name.input.value.trim();
      const u = nameOnly ? start.url : toAddress(url.input.value);
      if (!n) return fail('Give it a name.', name.input);
      if (u === null) return fail('Type a web address, like discord.com/app.', url.input);
      done({ name: n, url: u });
    };

    const save = button('SAVE', () => {}, 'primary');
    save.type = 'submit'; // Enter in a field saves too
    const row = el('div', 'buttons');
    if (canRemove) row.append(button('REMOVE', () => done('remove'), 'site-remove'));
    row.append(save, button('CANCEL', () => done(null)));
    form.append(row);
    d.append(el('h2', '', heading), form);
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    document.body.append(d);
    d.showModal();
    name.input.select();
  });
}

function field(label: string, value: string, example: string) {
  const row = el('label', 'site-field');
  const input = el('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = example;
  input.autocomplete = 'off';
  row.append(el('span', '', label), input);
  return { row, input };
}

// "discord.com/app" or a full http(s) address. Anything else (file:, words) is refused.
function toAddress(text: string): string | null {
  let s = text.trim();
  if (!s) return null;
  if (!/^[a-z][\w+.-]*:\/\//i.test(s)) s = (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(s) ? 'http://' : 'https://') + s;
  try {
    const u = new URL(s);
    const host = u.hostname.includes('.') || u.hostname === 'localhost';
    return /^https?:$/.test(u.protocol) && host ? u.href : null;
  } catch {
    return null;
  }
}
