// The GPU holds one engine at a time: the chat models (llama.cpp router, Strata) or the image model. Chat requests
// share the card with each other (the relay sorts out which chat model is loaded); a picture has it alone.
// Before the other kind gets the card, `handOver` frees it (unload the chat models, or stop the image engine). A
// running request is never cut off: the other kind waits until it ends. Waiters are served in order.
export type GpuUser = 'chat' | 'image';

type Waiter = { kind: GpuUser; onlyIfLast: boolean; go: (release: (() => void) | null) => void };

export class Gpu {
  private holder: GpuUser | null = null; // who uses the card right now
  private users = 0;
  private last: GpuUser | null = null; // who used it last (may still hold memory)
  private switching = false;
  private queue: Waiter[] = [];

  constructor(private handOver: (to: GpuUser) => Promise<void>) {}

  // Resolves when `kind` may use the card; call the returned function when done (once).
  acquire(kind: GpuUser): Promise<() => void> {
    return new Promise((resolve) => this.wait({ kind, onlyIfLast: false, go: (r) => resolve(r!) }));
  }

  // A turn only if `kind` still had the card last: no hand-over; null when the other kind took it meanwhile. For
  // clean-up such as stopping the idle image engine, which must not unload the chat models to do it.
  acquireIfLast(kind: GpuUser): Promise<(() => void) | null> {
    return new Promise((resolve) => this.wait({ kind, onlyIfLast: true, go: resolve }));
  }

  // Who has the card and how many wait (tests).
  get state(): { holder: GpuUser | null; users: number; waiting: number; last: GpuUser | null } {
    return { holder: this.holder, users: this.users, waiting: this.queue.length, last: this.last };
  }

  private wait(w: Waiter): void {
    this.queue.push(w);
    this.pump();
  }

  private pump(): void {
    if (this.switching) return;
    while (this.queue.length) {
      const next = this.queue[0];
      // Join only a running chat; a picture, or the other kind, waits until the card is free.
      if (this.users > 0 && !(next.kind === 'chat' && this.holder === 'chat' && !next.onlyIfLast)) return;
      if (this.users === 0 && this.last !== next.kind) {
        if (next.onlyIfLast) {
          this.queue.shift();
          next.go(null);
          continue;
        }
        this.switching = true;
        void this.handOver(next.kind)
          .catch((e) => console.warn(`GPU hand-over to ${next.kind} failed:`, e))
          .finally(() => {
            this.switching = false;
            this.last = next.kind;
            this.pump();
          });
        return;
      }
      this.queue.shift();
      this.holder = next.kind;
      this.last = next.kind;
      this.users++;
      let done = false;
      next.go(() => {
        if (done) return;
        done = true;
        if (--this.users === 0) this.holder = null;
        this.pump();
      });
    }
  }
}
