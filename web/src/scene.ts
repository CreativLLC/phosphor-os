// The OPERATOR scene (left panel, agents.ts): a small pixel room where the mascot acts out what Claude is doing
// and running helpers (crew) walk in, work beside it, and walk out when done. sceneplan.ts decides what shows;
// this file draws it with sprite canvases (sprites/engine.ts, one shared clock): the room, the mascot, one per
// helper. Walking is a stepped CSS transform, so nothing repaints per frame but the sprites' own frames.

import type { TabState } from '../../shared/protocol.ts';
import { crewKind, nameHash } from './sprites/crew.ts';
import { Sprite } from './sprites/engine.ts';
import { mascotAnim } from './sprites/mascot.ts';
import { roomAnim, ROOM_H } from './sprites/room.ts';
import { TROUPE_LOOKS, troupeAnim, type TroupeMove } from './sprites/troupe.ts';
import { crewSlots, DONE_MS, endedInError, ENTER_MS, LEAVE_MS, nextCrewChange, planCrew, POSE_MS, sceneActivity, slotX, type Activity, type Walker } from './sceneplan.ts';
import { el } from './ui.ts';

const CREW_Y = 12; // crew sprites' top row: their feet stand on the floor beside the mascot

const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

type Actor = { sprite: Sprite; walker: Walker; shown: string };

export class Scene {
  readonly el = el('div', 'scene');
  private room = new Sprite('sprite scene-room');
  private mascot = new Sprite('sprite scene-op');
  private more = el('span', 'scene-more');
  private actors = new Map<string, Actor>();
  private walkers: Walker[] = [];
  private tab?: TabState;
  private tabId?: string;
  private busy = new Map<string, boolean>();
  private ended = new Map<string, { at: number; error: boolean }>();
  private w = 0;
  private px = 2;
  private timer = 0;
  activity: Activity = 'idle';
  // Runs when the scene moves on by itself (a walk ends, the cheer is over); agents.ts redraws the card with it.
  onTimer = (): void => this.update(this.tab);

  constructor() {
    this.el.setAttribute('aria-hidden', 'true');
    this.el.append(this.room.canvas, this.mascot.canvas, this.more);
    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  private resize(): void {
    const width = this.el.clientWidth;
    if (!width) return;
    const px = width >= 420 ? 3 : 2;
    const w = Math.floor(width / px);
    if (w === this.w && px === this.px) return;
    this.w = w;
    this.px = px;
    this.el.style.setProperty('--px', String(px));
    this.el.style.height = `${ROOM_H * px}px`;
    this.room.play(roomAnim(w));
    this.update(this.tab, false);
  }

  // Called on every change of the open tab (and by the timers below).
  update(tab: TabState | undefined, animate = true): void {
    const now = Date.now();
    const id = tab?.meta.id;
    const switched = id !== this.tabId;
    this.tab = tab;
    this.tabId = id;
    if (tab && id) {
      // A turn that ends while the tab is open gets a cheer (or the error face) for a few seconds.
      const was = this.busy.get(id);
      if (was && !tab.meta.busy) this.ended.set(id, { at: now, error: endedInError(tab.items) });
      if (tab.meta.busy) this.ended.delete(id);
      this.busy.set(id, tab.meta.busy);
    }
    this.activity = sceneActivity(tab, (id && this.ended.get(id)) || null, now);
    this.mascot.play(mascotAnim(this.activity));
    this.el.dataset.act = this.activity;

    const plan = planCrew(switched ? [] : this.walkers, tab?.agents ?? [], now, this.w ? crewSlots(this.w) : 0, animate && !switched && !!this.w);
    this.walkers = plan.walkers;
    this.more.textContent = plan.extra ? `+${plan.extra}` : '';
    this.sync(now);

    // Wake up for the next walk step or the end of the cheer.
    clearTimeout(this.timer);
    const end = id && this.ended.get(id);
    const next = Math.min(nextCrewChange(this.walkers), ...this.walkers.filter((w) => w.phase === 'leave').map((w) => w.since + POSE_MS).filter((t) => t > now), end && now - end.at < DONE_MS ? end.at + DONE_MS : Infinity);
    if (next < Infinity) this.timer = window.setTimeout(() => this.onTimer(), Math.max(16, next - now + 5));
  }

  private sync(now: number): void {
    const keep = new Set(this.walkers.map((w) => w.id));
    for (const [id, a] of this.actors) {
      if (keep.has(id)) continue;
      a.sprite.dispose();
      a.sprite.canvas.remove();
      this.actors.delete(id);
    }
    for (const w of this.walkers) {
      let a = this.actors.get(w.id);
      if (!a) {
        const sprite = new Sprite('sprite scene-crew');
        sprite.canvas.style.setProperty('--y', String(CREW_Y));
        a = { sprite, walker: w, shown: '' };
        this.actors.set(w.id, a);
        this.el.insertBefore(sprite.canvas, this.more);
        if (w.phase === 'enter') this.place(a, this.w + 2, 0); // starts off stage, right
      }
      a.walker = w;
      this.stage(a, now);
    }
  }

  // Where an actor stands and what it does at `now`.
  private stage(a: Actor, now: number): void {
    const w = a.walker;
    const kind = crewKind(w.agent.name);
    const look = nameHash(w.agent.name) % TROUPE_LOOKS;
    const home = slotX(w.slot);
    const off = this.w + 2;
    let move: TroupeMove = 'work';
    let out = false;
    let x = home;
    let ms = 0;
    if (w.phase === 'enter') {
      move = 'walk';
      ms = Math.max(0, w.since + ENTER_MS - now);
    } else if (w.phase === 'leave') {
      const walkAt = w.since + POSE_MS;
      if (now < walkAt) move = w.agent.status;
      else {
        move = 'walk';
        out = true;
        x = off;
        ms = Math.max(0, w.since + LEAVE_MS - now);
      }
    }
    const step = `${w.phase}/${move}/${out}`;
    a.sprite.play(troupeAnim(kind, look, move, out));
    a.sprite.canvas.title = `${w.agent.description || w.agent.name}`;
    if (a.shown !== step) {
      a.shown = step;
      this.place(a, x, ms);
    }
  }

  // Walk to x (grid cells) over ms, in whole-pixel steps; reduced motion jumps there.
  private place(a: Actor, x: number, ms: number): void {
    const c = a.sprite.canvas;
    const from = Number(c.style.getPropertyValue('--x') || x);
    const steps = Math.max(1, Math.round(Math.abs(x - from) / 2));
    c.style.transition = ms > 0 && !reduced?.matches ? `transform ${ms}ms steps(${steps}, end)` : 'none';
    if (ms > 0) void c.offsetWidth; // start from where it stands now
    c.style.setProperty('--x', String(x));
  }
}
