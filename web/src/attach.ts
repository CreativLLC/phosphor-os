import type { Attachment } from '../../shared/protocol.ts';
import { shellApi } from './shellapi.ts';
import { store } from './store.ts';
import { button, el, toast } from './ui.ts';

// Attachments waiting in the message box: paste a screenshot, drop files on the chat, or press ATTACH.
// Each file uploads right away (POST /api/upload); SEND passes the upload ids with the message.

type Pending = { key: string; name: string; image: boolean; preview?: string; att?: Attachment; failed?: boolean };

const BIG_IMAGE = 3.5 * 1024 * 1024; // Claude sees images inline up to about this size
const MAX_SIDE = 2400; // bigger images are scaled down first (phone photos)

const pending = new Map<string, Pending[]>(); // per tab
let tray: HTMLElement;

export function mountAttach(composer: HTMLElement, dropZone: HTMLElement): void {
  tray = composer.querySelector('#tray') as HTMLElement;
  const picker = composer.querySelector('#file') as HTMLInputElement;
  const attachBtn = composer.querySelector('#attach') as HTMLButtonElement;

  attachBtn.onclick = () => picker.click();
  picker.onchange = () => {
    void addFiles([...(picker.files ?? [])]);
    picker.value = '';
  };

  // Paste: only take over when the clipboard holds files (a screenshot); plain text pastes as usual.
  // On Linux (Wayland) a copied picture often reaches the page as nothing at all: then the desktop app reads it.
  document.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    const files = [...(data?.files ?? [])];
    for (const item of data?.items ?? []) {
      const f = item.kind === 'file' && !files.length ? item.getAsFile() : null;
      if (f) files.push(f);
    }
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    if (data?.types.includes('text/plain') || !shellApi?.clipboardImage) return;
    e.preventDefault();
    void shellApi.clipboardImage().then((png) => {
      if (!png) return;
      const name = `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`;
      void addFiles([new File([new Uint8Array(png)], name, { type: 'image/png' })]);
    });
  });

  dropZone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('drop-target');
  });
  dropZone.addEventListener('dragleave', (e) => {
    if (e.target === dropZone || !dropZone.contains(e.relatedTarget as Node)) dropZone.classList.remove('drop-target');
  });
  dropZone.addEventListener('drop', (e) => {
    dropZone.classList.remove('drop-target');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  });

  store.on((c) => {
    if (c.kind === 'active') render();
  });
  render();
}

// Upload ids ready to send, or null while something is still uploading.
export function takeAttachments(tab: string): string[] | null {
  const list = pending.get(tab) ?? [];
  if (list.some((p) => !p.att && !p.failed)) {
    toast('Still uploading. Send again in a moment.');
    return null;
  }
  const ids = list.filter((p) => p.att).map((p) => p.att!.id);
  for (const p of list) if (p.preview) URL.revokeObjectURL(p.preview);
  pending.delete(tab);
  render();
  return ids;
}

async function addFiles(files: File[]): Promise<void> {
  const tab = store.active;
  if (!tab || !files.length) return;
  if (store.demo) {
    toast('Demo mode: attachments need the real server.');
    return;
  }
  const list = pending.get(tab) ?? [];
  pending.set(tab, list);
  await Promise.all(
    files.map(async (raw, i) => {
      const image = raw.type.startsWith('image/');
      const name = raw.name && raw.name !== 'image.png' ? raw.name : `screenshot-${stamp()}${i ? '-' + i : ''}.png`;
      const p: Pending = { key: Math.random().toString(36).slice(2), name, image, preview: image ? URL.createObjectURL(raw) : undefined };
      list.push(p);
      render();
      try {
        const file = image ? await shrink(raw, name) : raw;
        const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
        const data = (await r.json().catch(() => ({}))) as Attachment & { error?: string };
        if (!r.ok) throw new Error(r.status === 404 ? 'The server update for attachments has not loaded yet. Reload in a minute.' : (data.error ?? 'Upload failed.'));
        p.att = data;
      } catch (e) {
        p.failed = true;
        toast(`${name}: ${e instanceof Error ? e.message : 'upload failed'}`);
      }
      render();
    }),
  );
}

// Scale big images down so Claude can see them inline. Screenshots stay PNG (sharp text); photos become JPEG.
async function shrink(file: File, name: string): Promise<File> {
  const named = name === file.name ? file : new File([file], name, { type: file.type });
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return named;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return named; // a format the browser can't open: send as is
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= BIG_IMAGE) return named;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const toBlob = (type: string, q?: number) => new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, q));
  let blob = file.type === 'image/png' ? await toBlob('image/png') : null;
  let type = 'image/png';
  if (!blob || blob.size > BIG_IMAGE) {
    blob = await toBlob('image/jpeg', 0.88);
    type = 'image/jpeg';
  }
  if (!blob) return named;
  const base = name.replace(/\.[^.]+$/, '');
  return new File([blob], `${base}.${type === 'image/png' ? 'png' : 'jpg'}`, { type });
}

function stamp(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function render(): void {
  const tab = store.active;
  const list = (tab && pending.get(tab)) || [];
  tray.hidden = list.length === 0;
  tray.replaceChildren(
    ...list.map((p) => {
      const chip = el('div', `att-chip${p.att ? '' : p.failed ? ' failed' : ' busy'}`);
      if (p.preview) {
        const img = el('img');
        img.src = p.preview;
        img.alt = p.name;
        chip.append(img);
      } else {
        chip.append(el('span', 'att-icon', '[FILE]'));
      }
      chip.append(el('span', 'att-name', p.failed ? `${p.name} (FAILED)` : p.att ? p.name : `${p.name} ...`));
      chip.append(
        button('×', () => {
          if (p.preview) URL.revokeObjectURL(p.preview);
          const l = pending.get(tab!) ?? [];
          l.splice(l.indexOf(p), 1);
          render();
        }, 'att-x'),
      );
      chip.title = p.name;
      return chip;
    }),
  );
}
