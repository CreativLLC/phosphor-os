import type { Item, PatchKey, SdkUpdate, ServerEvent, TabState } from '../../shared/protocol.ts';

// What changed. Components listen and redraw only what they need.
export type Change =
  | { kind: 'tabs' } // tab list or any tab's meta (title, busy, attention) changed
  | { kind: 'active' } // the user switched tabs
  | { kind: 'reset'; tab: string } // a tab's whole state was replaced
  | { kind: 'item'; tab: string; item: Item; op: 'add' | 'update' }
  | { kind: 'delta'; tab: string; id: string; text: string }
  | { kind: 'patch'; tab: string; key: PatchKey }
  | { kind: 'connection' }
  | { kind: 'sdk_update'; state: SdkUpdate } // a newer Claude Code (Agent SDK) waits, or the update runs (sdkupdate.ts)
  | { kind: 'undo'; result: Extract<ServerEvent, { t: 'undo_result' }> };

class Store {
  tabs = new Map<string, TabState>();
  active: string | null = null;
  connected = false;
  demo = false;
  private listeners = new Set<(c: Change) => void>();

  on(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(c: Change): void {
    for (const fn of this.listeners) fn(c);
  }

  current(): TabState | undefined {
    return this.active ? this.tabs.get(this.active) : undefined;
  }

  setActive(id: string | null): void {
    if (this.active === id) return;
    this.active = id;
    try {
      if (id) localStorage.setItem('phosphor.activeTab', id);
    } catch {
      /* storage blocked: fine */
    }
    this.emit({ kind: 'active' });
  }

  savedActive(): string | null {
    try {
      return localStorage.getItem('phosphor.activeTab');
    } catch {
      return null;
    }
  }
}

export const store = new Store();

// Claude is working in this tab: its turn runs, or a helper (subagent) still runs after the turn ended.
export const working = (t: TabState): boolean => t.meta.busy || t.agents.some((a) => a.status === 'running');

// Run render(tab) now, and again whenever the active tab changes or one of `keys` changes on it.
export function watchActive(keys: PatchKey[], render: (tab: TabState | undefined) => void): void {
  render(store.current());
  store.on((c) => {
    if (c.kind === 'active' || (c.kind === 'reset' && c.tab === store.active) || (c.kind === 'patch' && c.tab === store.active && keys.includes(c.key))) {
      render(store.current());
    }
  });
}
