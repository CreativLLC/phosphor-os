// FOCUS (web/src/focus.ts): toggles, keys, remembered view, the news dot. No browser: a tiny fake page.
// Run: npx tsx tests/focus.ts
import assert from 'node:assert/strict';

const classes = new Set<string>();
const makeClassList = (set: Set<string>) => ({
  toggle: (c: string, on?: boolean) => {
    const want = on ?? !set.has(c);
    if (want) set.add(c);
    else set.delete(c);
    return want;
  },
  add: (c: string) => void set.add(c),
  remove: (c: string) => void set.delete(c),
  contains: (c: string) => set.has(c),
});
const button = () => {
  const set = new Set<string>();
  return { set, classList: makeClassList(set), setAttribute() {}, onclick: null as null | (() => void) };
};
const listeners: Record<string, (e: unknown) => void> = {};
const storage = new Map<string, string>();
Object.assign(globalThis, {
  document: {
    documentElement: { classList: makeClassList(classes) },
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
    getElementById: () => null,
  },
  localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) },
});

const { mountFocus } = await import('../web/src/focus.ts');
const { store } = await import('../web/src/store.ts');

const btns = { left: button(), right: button(), focus: button() };
mountFocus(btns as never);
const saved = () => JSON.parse(storage.get('phosphor.view')!);
const key = (code: string, extra: object = {}) => {
  let prevented = false;
  listeners.keydown({ code, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, isComposing: false, preventDefault: () => (prevented = true), ...extra });
  return prevented;
};

// Start: both shown, both lit.
assert.deepEqual(saved(), { left: false, right: false });
assert.ok(btns.left.set.has('on') && btns.right.set.has('on') && !btns.focus.set.has('on'));

// Buttons toggle one side.
btns.left.onclick!();
assert.ok(classes.has('hide-left') && !classes.has('hide-right'));
assert.deepEqual(saved(), { left: true, right: false });
assert.ok(!btns.left.set.has('on'));

// FOCUS hides both; again shows both.
btns.focus.onclick!();
assert.ok(classes.has('hide-left') && classes.has('hide-right') && btns.focus.set.has('on'));
btns.focus.onclick!();
assert.ok(!classes.has('hide-left') && !classes.has('hide-right') && !btns.focus.set.has('on'));

// Keys: Ctrl+[ left, Ctrl+] right, Ctrl+\ both; other combinations are left alone.
assert.ok(key('BracketLeft') && classes.has('hide-left'));
assert.ok(key('BracketRight') && classes.has('hide-right'));
assert.ok(key('BracketLeft') && !classes.has('hide-left'));
assert.ok(key('Backslash') && classes.has('hide-left') && classes.has('hide-right')); // one was hidden: hide both
assert.ok(key('Backslash') && !classes.has('hide-left') && !classes.has('hide-right'));
assert.equal(key('BracketLeft', { shiftKey: true }), false);
assert.equal(key('BracketLeft', { altKey: true }), false);
assert.equal(key('KeyA'), false);

// News dot: only on a hidden panel's button, when a chat starts needing you; shown again clears it.
const tab = (attention: boolean, busy = false) => ({ meta: { id: 't1', title: 'x', busy, attention, createdAt: 0 } }) as never;
store.tabs.set('t1', tab(false));
store.emit({ kind: 'tabs' }); // primes
btns.left.onclick!(); // hide left
store.tabs.set('t1', tab(true));
store.emit({ kind: 'tabs' });
assert.ok(btns.left.set.has('news'), 'dot on the hidden left button');
assert.ok(!btns.right.set.has('news'), 'no dot on a shown panel');
btns.left.onclick!(); // show again
assert.ok(!btns.left.set.has('news'), 'dot clears when the panel shows');

console.log('focus: ok');
