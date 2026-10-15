import { AUTO_MODEL, type Effort, type ModelChoice, type TabState } from '../../shared/protocol.ts';
import { send } from './net.ts';
import { store, watchActive } from './store.ts';

// Model and thinking-level pickers in the message box row. One choice per tab; the server saves it.
// AUTO (first model choice): a router picks model and thinking level for each message; both pickers read AUTO.

// Same list as EFFORTS in shared/protocol.ts (used when the model list has not loaded).
const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
let models: ModelChoice[] = [];
let rerender: () => void = () => {};

// Demo mode has no server; it hands in a fake list.
export function setModels(list: ModelChoice[]): void {
  models = list;
  rerender();
}

const opt = (label: string, value: string, title = ''): HTMLOptionElement => {
  const o = new Option(label, value);
  if (title) o.title = title;
  return o;
};

const shortModel = (id: string) => id.replace(/^claude-/, '').toUpperCase();

export function mountPickers(modelSel: HTMLSelectElement, effortSel: HTMLSelectElement): void {
  modelSel.title = 'Model for this tab';
  effortSel.title = 'Thinking level for this tab: how hard Claude thinks before it answers';

  const render = (tab: TabState | undefined) => {
    const auto = !!tab?.info.auto;
    const cur = tab?.info.model ?? '';
    const match = models.find((m) => m.value === cur) ?? models.find((m) => m.resolved === cur);
    const modelOpts = models.map((m) => opt(m.label.toUpperCase(), m.value, m.description));
    if (!match && cur) modelOpts.unshift(opt(shortModel(cur), cur));
    if (modelOpts.length === 0) modelOpts.push(opt('MODEL', ''));
    modelOpts.unshift(opt('AUTO', AUTO_MODEL, 'Picks the model and thinking level for each message. Leans high; goes up when needed, down only on a new topic.'));
    modelSel.replaceChildren(...modelOpts);
    modelSel.value = auto ? AUTO_MODEL : (match?.value ?? cur);
    modelSel.disabled = !tab || models.length === 0;
    modelSel.title = auto ? `Model for this tab: AUTO. Now ${match?.label ?? shortModel(cur)}, thinking ${tab?.info.effort || 'default'}` : 'Model for this tab';

    // A model with an empty efforts list has no thinking levels.
    const noThinking = match !== undefined && match.efforts.length === 0;
    const levels = match?.efforts.length ? match.efforts : LEVELS;
    const effort = tab?.info.effort ?? '';
    const effortOpts = auto
      ? [opt('THINK: AUTO', AUTO_MODEL, 'The router picks the thinking level. Choose a level to leave AUTO and keep the current model.'), ...levels.map((l) => opt(`THINK: ${l.toUpperCase()}`, l))]
      : noThinking
      ? [opt('THINK: N/A', '')]
      : [...(effort ? [] : [opt('THINK: DEFAULT', '')]), ...levels.map((l) => opt(`THINK: ${l.toUpperCase()}`, l))];
    effortSel.replaceChildren(...effortOpts);
    effortSel.value = auto ? AUTO_MODEL : noThinking ? '' : effort;
    effortSel.disabled = !tab || (noThinking && !auto);
  };
  rerender = () => render(store.current());

  modelSel.onchange = () => {
    if (store.active && modelSel.value) send({ t: 'model', tab: store.active, model: modelSel.value });
  };
  effortSel.onchange = () => {
    if (store.active && effortSel.value && effortSel.value !== AUTO_MODEL) send({ t: 'effort', tab: store.active, effort: effortSel.value as Effort });
  };

  watchActive(['info'], render);

  const load = async () => {
    try {
      const r = await fetch('/api/models');
      if (!r.ok) return;
      models = ((await r.json()) as { models?: ModelChoice[] }).models ?? [];
      rerender();
    } catch {
      /* server without /api/models yet: show the current model only */
    }
  };
  store.on((c) => {
    if (c.kind === 'connection' && store.connected) void load();
  });
}
