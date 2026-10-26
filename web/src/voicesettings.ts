import './voicesettings.css';
import { shellApi, type DictateInfo } from './shellapi.ts';
import { store } from './store.ts';
import { button, confirmBox, el, toast } from './ui.ts';

// SETTINGS > VOICE:
// - DICTATE in any app (desktop app only): the floating mic SHOW / HIDE and CLEAN UP, through the desktop app
//   (shell/dictate.mjs; on Linux the Omarchy pack's settings file). Read again each time SETTINGS opens, since the
//   mic's own right-click menu changes the same settings.
// - PHONE KEYBOARD (every device, so the phone can copy its key): this PC's speech engine for a phone keyboard such as
//   Dictate Keyboard: the base URL, the API key (COPY, NEW TOKEN), the model, the steps. API: server/voiceapi.ts.

type Keyboard = { token: string; base: string | null; model: string };

const DEMO_INFO: DictateInfo = { where: 'pack', icon: true, cleanup: false, keys: 'Ctrl+Space (tap, or hold to talk)' };
const DEMO_KEYBOARD: Keyboard = { token: 'phos_demo0000000000000000000000000000000000k3y', base: 'https://your-pc.your-tailnet.ts.net/v1/', model: 'parakeet-tdt-0.6b-v2' };

export function voiceSection(): HTMLElement {
  const box = el('div', 'set-voice');
  const anywhere = el('div');
  box.append(el('div', 'set-label', 'VOICE'), anywhere, phoneKeyboard());
  let info: DictateInfo | null = store.demo ? { ...DEMO_INFO } : null;

  const seg = (choices: [string, boolean][], pick: (i: number) => void) => {
    const s = el('div', 'seg');
    choices.forEach(([label, on], i) => {
      const b = button(label, () => pick(i));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      s.append(b);
    });
    return s;
  };
  const set = async (patch: { icon?: boolean; cleanup?: boolean }) => {
    if (store.demo && info) info = { ...info, ...patch };
    else info = (await shellApi?.setDictate?.(patch).catch(() => null)) ?? info;
    draw();
  };
  const draw = () => {
    if (!info) return anywhere.replaceChildren(); // a browser or the phone: the floating mic belongs to the desktop app
    if (info.where === 'none') return anywhere.replaceChildren(el('div', 'voice-note', 'DICTATE in any app needs the desktop pack on this PC: bash scripts/setup-linux.sh'));
    anywhere.replaceChildren(
      el('div', 'set-sub', 'FLOATING MIC'),
      seg([['SHOW', info.icon], ['HIDE', !info.icon]], (i) => void set({ icon: i === 0 })),
      el('div', 'set-sub', 'CLEAN UP'),
      seg([['ON', info.cleanup], ['OFF', !info.cleanup]], (i) => void set({ cleanup: i === 0 })),
      el('div', 'voice-note', `DICTATE in any app: click the mic (or ${info.keys}), talk, click again. The words go in where the cursor is, in the window that has the keyboard. CLEAN UP tidies them first.`),
    );
  };
  const load = async () => {
    if (!store.demo) info = (await shellApi?.dictate?.().catch(() => null)) ?? null;
    draw();
  };
  // SETTINGS opened: read the settings again.
  new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && void load()).observe(box);
  draw();
  return box;
}

function phoneKeyboard(): HTMLElement {
  const wrap = el('div', 'voice-phone');
  const body = el('div', 'voice-phone-body');
  body.hidden = true;
  const head = button('PHONE KEYBOARD ▸', () => {
    body.hidden = !body.hidden;
    head.textContent = body.hidden ? 'PHONE KEYBOARD ▸' : 'PHONE KEYBOARD ▾';
    if (!body.hidden) void load();
  }, 'voice-phone-btn');
  head.title = "Use this PC's speech engine from a phone keyboard (Dictate Keyboard on Android)";
  wrap.append(head, body);

  const copy = (value: string, what: string) =>
    button('COPY', () =>
      void navigator.clipboard.writeText(value).then(
        () => toast(`${what} copied.`, 2000),
        () => toast('Could not copy here: select it and copy by hand.'),
      ),
    );
  const row = (...items: HTMLElement[]) => {
    const r = el('div', 'voice-row');
    r.append(...items);
    return r;
  };

  async function load(fresh = false): Promise<void> {
    let kb: Keyboard | null = store.demo ? DEMO_KEYBOARD : null;
    if (!store.demo) {
      const r = await fetch(fresh ? '/api/voice/keyboard/new' : '/api/voice/keyboard', fresh ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}).catch(() => null);
      kb = r?.ok ? ((await r.json()) as Keyboard) : null;
      if (!kb) {
        body.replaceChildren(el('div', 'voice-note', r?.status === 404 ? 'The server update for this has not loaded yet. Try again in a minute.' : 'Could not get the key from the PC.'));
        return;
      }
    }
    draw(kb!);
  }

  function draw(kb: Keyboard): void {
    // On the phone the page's own address is the one to use; on the PC, the tailnet address Tailscale gives.
    const here = location.protocol === 'https:' && location.hostname.endsWith('.ts.net') ? `${location.origin}/v1/` : null;
    const base = here ?? kb.base;
    const key = el('code', 'voice-val');
    let shown = false;
    const showKey = () => (key.textContent = shown ? kb.token : `${kb.token.slice(0, 5)}••••••••${kb.token.slice(-4)}`);
    showKey();
    const reveal = button('SHOW', () => {
      shown = !shown;
      reveal.textContent = shown ? 'HIDE' : 'SHOW';
      showKey();
    });
    const renew = button('NEW TOKEN', async () => {
      const ok = await confirmBox('NEW TOKEN', 'The phone stops working until you put the new key into its keyboard. Make a new key?', 'NEW TOKEN');
      if (!ok) return;
      if (store.demo) return toast('Demo: no new key.', 2000);
      await load(true);
      toast('New key made. Put it into the phone keyboard.', 4000);
    });
    const steps = el('ol', 'voice-steps');
    for (const s of [
      'Phone: Tailscale on, logged in like this PC.',
      'Install Dictate Keyboard (Google Play, or github.com/DevEmperor/DictateKeyboard).',
      'In Dictate: Settings > AI providers > Add your own server.',
      'Base URL and API key: the two above (the URL ends in /v1/).',
      `Transcription model: ${kb.model} (from the list, or any name).`,
      'Use it for transcription. Rewording: another provider or off. Real-time streaming: off.',
    ])
      steps.append(el('li', '', s));
    body.replaceChildren(
      el('div', 'set-sub', 'BASE URL'),
      base ? row(el('code', 'voice-val', base), copy(base, 'Base URL')) : el('div', 'voice-note', 'Tailscale is not up on this PC. Its address is https://<this PC>.<your tailnet>.ts.net/v1/ once tailscale serve runs (docs/LINUX.md).'),
      el('div', 'set-sub', 'API KEY'),
      row(key),
      row(reveal, copy(kb.token, 'API key'), renew),
      el('div', 'set-sub', 'MODEL'),
      row(el('code', 'voice-val', kb.model)),
      steps,
      el('div', 'voice-note', 'Works while this PC is on. The speech engine is English. Only phones on your tailnet reach it.'),
    );
  }
  return wrap;
}
