import { funSettings, onFun, setFun, type FunSettings } from './funsettings.ts';
import { setGameMode } from './gamemode.ts';
import { fittingVoices, onVoices, speak, voiceLabel, voiceSupported } from './shipvoice.ts';
import { button, el } from './ui.ts';

// SETTINGS rows for the fun pack: GAME MODE, VOICE OUT (+ voice and chime while it is on).
// settings.ts adds this section with one line.

type Choice<K extends keyof FunSettings> = { label: string; value: FunSettings[K]; title?: string };

export function funSection(): HTMLElement {
  const box = el('div', 'set-fun');
  const syncs: (() => void)[] = [];

  const seg = <K extends keyof FunSettings>(key: K, choices: Choice<K>[], pick: (v: FunSettings[K]) => void = (v) => setFun(key, v)) => {
    const s = el('div', 'seg');
    const btns = choices.map((c) => {
      const b = button(c.label, () => pick(c.value));
      if (c.title) b.title = c.title;
      return b;
    });
    s.append(...btns);
    syncs.push(() =>
      btns.forEach((b, i) => {
        const on = funSettings()[key] === choices[i].value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }),
    );
    return s;
  };
  const row = (label: string, body: HTMLElement, action?: HTMLButtonElement) => {
    const r = el('div', 'set-row');
    const head = el('div', 'set-label fun-label', label);
    if (action) head.append(action);
    body.setAttribute('role', 'group');
    body.setAttribute('aria-label', label);
    r.append(head, body);
    return r;
  };
  const mini = (label: string, title: string, fn: () => void) => {
    const b = button(label, fn, 'fun-mini');
    b.title = title;
    return b;
  };

  box.append(
    row(
      'GAME MODE',
      seg(
        'game',
        [
          { label: 'ON', value: true, title: 'Effects, sounds and voice off; animations stop' },
          { label: 'OFF', value: false, title: 'Put my settings back' },
        ],
        (v) => setGameMode(v),
      ),
    ),
  );

  if (voiceSupported()) {
    box.append(
      row(
        'VOICE OUT',
        seg('voiceOut', [
          { label: 'OFF', value: 'off' },
          { label: 'SHORT', value: 'short', title: 'Read the first two sentences of each finished reply' },
          { label: 'FULL', value: 'full', title: 'Read each finished reply (code and tables left out)' },
        ]),
        mini('TEST', 'Hear the voice', () => speak('Voice check. Ship computer online.')),
      ),
    );

    // Voice picker and chime: only while VOICE OUT is on.
    const extra = el('div', 'fun-voice');
    const pickRow = el('div', 'set-row');
    const pick = el('select', 'fun-select');
    pick.setAttribute('aria-label', 'Voice');
    pick.onchange = () => setFun('voice', pick.value);
    pickRow.append(el('div', 'set-label', 'VOICE'), pick);
    const fillVoices = () => {
      const list = fittingVoices();
      pickRow.hidden = list.length < 2;
      const want = list.find((v) => v.voiceURI === funSettings().voice) ?? list[0];
      pick.replaceChildren(
        ...list.map((v) => {
          const o = el('option', '', voiceLabel(v));
          o.value = v.voiceURI;
          o.selected = v === want;
          return o;
        }),
      );
    };
    fillVoices();
    onVoices(fillVoices);
    extra.append(
      pickRow,
      row('CHIME BEFORE SPEAKING', seg('chime', [
        { label: 'ON', value: true, title: 'Short chime first (only when SOUND is on)' },
        { label: 'OFF', value: false },
      ])),
    );
    syncs.push(() => (extra.hidden = funSettings().voiceOut === 'off'));
    box.append(extra);
  } else {
    box.append(row('VOICE OUT', el('div', 'set-foot fun-note', 'This browser cannot speak.')));
  }

  const sync = () => syncs.forEach((f) => f());
  sync();
  onFun(sync);
  return box;
}
