// The operator in the scene (web/src/scene.ts), 48 x 36, in the shaded scene style (ramps in engine.ts).
// Owner: art team. The same character as operator.ts (a monitor-headed operator with rabbit-ear antennas and
// a high-collar flight jacket), redrawn with outlines and shading, light from the top left. One animation per
// activity (sceneplan.ts says which): seated at the console for desk work, standing for the rest.

import { anim, frame, part, type Anim, type Grid, type Layer, type Part } from './engine.ts';
import type { Activity } from '../sceneplan.ts';

export const MASCOT_W = 48;
export const MASCOT_H = 36;

// ---------- Head: antennas and the monitor, 16 x 15 ----------

const ANTENNA = part`
.kk..........kk.
k@wk........kw@k
.kk9........9kk.
....9k8778k9....`;

const MONITOR = part`
.kkkkkkkkkkkkkk.
k99999999999998k
k98888888888887k
k98oooooooooo87k
k98oooooooooo87k
k98oooooooooo87k
k98oooooooooo87k
k98oooooooooo87k
k98888888888877k
k87777777y7r777k
.kkkkkkkkkkkkkk.`;

// Faces: 10 x 5 on the screen at (3, 3) of the monitor. 'c' glows in the accent color.
type Face = 'open' | 'blink' | 'down' | 'up' | 'right' | 'happy' | 'alert' | 'x' | 'focus' | 'squint';
const FACE: Record<Face, Part> = {
  open: part`
C.........
..wc..wc..
..cc..cc..
..c....c..
...cccc...`,
  blink: part`
C.........
..........
.ccc..ccc.
..c....c..
...cccc...`,
  down: part`
C.........
..........
..wc..wc..
..cc..cc..
....cc....`,
  up: part`
C..wc..wc.
...cc..cc.
..........
......cc..
..........`,
  right: part`
C.........
....wc.wc.
....cc.cc.
..........
......cc..`,
  happy: part`
C.........
..c....c..
.c.c..c.c.
...cccc...
....cc....`,
  alert: part`
.ccc..ccc.
.cwc..cwc.
.ccc..ccc.
..........
....cc....`,
  x: part`
.c.c..c.c.
..c....c..
.c.c..c.c.
..........
..c.cc.c..`,
  focus: part`
C.........
..........
.ccc..ccc.
..........
...ccc....`,
  squint: part`
C.........
..........
.cc....cc.
...c..c...
..........`,
};
// The screen flashes bright (needs you): the face cut out of the glow.
const flashFace = (p: Part): Part => p.map((r) => [...r].map((ch) => (ch === 'c' || ch === 'w' ? 'o' : 'c')).join(''));

// ---------- Body, 18 wide: collar, jacket, belt, legs ----------

const TORSO = part`
.....k6k99k4k.....
...kk66k99k44kk...
..k66665w955544k..
..k66655k955444k..
..k66555k855444k..
..k65555k854444k..
..knnnnnyynnnnnk..`;

const LEGS = part`
...k8888777777k...
...k8887kk7777k...
...k887k..k877k...
...k887k..k877k...
...k887k..k777k...
..k8777k..k8777k..
.k87777k..k77778k.
.kkkkkkk..kkkkkkk.`;

const SHADOW = part`
..kkkkkkkkkkkkkk..
kkkkkkkkkkkkkkkkkk
..kkkkkkkkkkkkkk..`;

// Arms, 4 wide on the torso's outline. Down: hanging at the sides. Up: raised (wave, cheer, hold).
const ARM_L = part`
.kk.
k66k
k65k
k65k
k65k
kwwk
kw9k
.kk.`;
const ARM_R = part`
.kk.
k54k
k54k
k54k
k44k
k99k
k98k
.kk.`;
const UP_L = part`
.kk.
kwwk
kw9k
k66k
k65k
k65k
k65k
k65k
.kk.`;
const UP_R = part`
.kk.
k99k
k98k
k54k
k54k
k54k
k44k
k44k
.kk.`;
// Raised and tilted out (the other wave frame, the cheer).
const OUT_L = part`
.kk...
kwwk..
kw9k..
.k66k.
.k65k.
..k65k
..k65k
..k65k
...kk.`;
const OUT_R = part`
...kk.
..k99k
..k98k
.k54k.
.k54k.
k54k..
k44k..
k44k..
.kk...`;
type Arms = { l?: Layer | null; r?: Layer | null };

// Standing figure, 20 x 30, top-left at (x, y). Arms are placed relative to the figure.
function figure(x: number, y: number, face: Part, arms: Arms = {}, flash = false): Layer[] {
  const rel = (l: Layer | null | undefined): Layer | null => (l ? [l[0], l[1] + x, l[2] + y] : null);
  return [
    [LEGS, x + 1, y + 22],
    [TORSO, x + 1, y + 15],
    [ANTENNA, x + 2, y],
    [MONITOR, x + 2, y + 4],
    [flash ? flashFace(face) : face, x + 5, y + 7],
    arms.l === undefined ? [ARM_L, x, y + 17] : rel(arms.l),
    arms.r === undefined ? [ARM_R, x + 16, y + 17] : rel(arms.r),
  ];
}

// ---------- Props ----------

const DESK = part`
..kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk..
.k888888888888888888888888888888888887k.
k99999999999999999999999999999999999998k
kwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww9k
kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk
k8777777777777777777777777777777777777-k
k87kkkkkkkk77777777777777777-7-7-7-777-k
k87kooooook77777777777777777-7-7-7-777-k
k87kooooook77777777777777777-7-7-7-777-k
k87kkkkkkkk77777777777777777-7-7-7-777-k
k8------------------------------------7k
.kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk.`;

// Status lights on the desk front, at (14, 7) of the desk.
const LIGHTS = [part`r..y..G..B`, part`k..y..k..B`, part`r..k..G..k`, part`k..k..k..k`];
const ALARM = [part`r..r..r..r`, part`k..k..k..k`];
// The little scope on the desk front, at (4, 7) of the desk.
const SCOPE = [
  part`
G...G.
.GGG.G`,
  part`
.G...G
G.GGG.`,
  part`
GG...G
..GGG.`,
];
const SCOPE_FLAT = part`
......
GGGGGG`;
const SCOPE_TEXT = [
  part`
GG....
......`,
  part`
GGGG..
GG....`,
  part`
GGGGG.
GGGG..`,
];
const SCOPE_ERR = part`
r.r.r.
.r.r.r`;

const KEYBOARD = part`
.kkkkkkkkkkkkkkkk.
k9w9w9w9w9w9w9w98k
k8787878787878787k
.kkkkkkkkkkkkkkkk.`;
const KEY_FLASH = [part`y`, part`..y`, part`.....y`, part`...y`];
// Code glyphs rising off the keyboard while editing: < / >
const GLYPHS = part`
.G...G.G.
G...G...G
.G.G...G.`;

const MUG = part`
kkkkk..
kwwwkk.
k998k.k
k987kk.
kkkkk..`;
const STEAM = [
  part`
.9.
..9
.9.`,
  part`
..9
.9.
..9`,
];

const THINK = part`
....kkkkkkk....
..kkwwwwwwwkk..
.kwwwwwwwwwwwk.
kwwwwwwwwwwwwwk
kwwwwwwwwwwwwwk
.kwwwwwwwwwwwk.
..kkkwwwwwkkk..
.....kkkkk.....
...kk..........
..kwwk.........
...kk..........
.kk............
kwk............
.k.............`;
const THINK_DOTS = [part`k`, part`k..k`, part`k..k..k`];

// Speech bubble (writing a reply): lines fill in.
const SAY = part`
.kkkkkkkkkkkk.
kwwwwwwwwwwwwk
kwwwwwwwwwwwwk
kwwwwwwwwwwwwk
kwwwwwwwwwwwwk
.kkkwwkkkkkkk.
...kwk........
..kk..........`;
const SAY_LINES = [
  part`
888.....`,
  part`
8888888.
888.....`,
  part`
88888888
8888888.
8888....`,
];

const BOOK = part`
..kkkkkkkkkkkkk..
.kw88w8wk977979k.
.kw8w88wk979779k.
kww8w8wwk9799799k
kbbbbbbbkbbbbbbbk
.kkkkkkkkkkkkkkk.`;
// A page turning over the spine.
const PAGE = [
  part`
.kk
kwk
kwk
kwk`,
  part`
kkk.
kwwk
.kwk`,
];

const ANVIL = part`
....kkkkkkkkkk.
.kkk9999999998k
k9999999999987k
.kk8888888877k.
.....k8877k....
.....k8777k....
...kk888777kk..
..k988887777k..
..kkkkkkkkkkk..`;
const HOT = [part`
kkkkk
kyyrk
kkkkk`, part`
kkkkk
kyyyk
kkkkk`];
// Hammer up (above the raised right hand) and down (on the anvil).
const HAMMER_UP = part`
.kkkkkkk.
k9999998k
k8888877k
.kkkNkkk.
...kNk...
...knk...
...kNk...
...knk...
...kNk...`;
const SWING_DOWN = part`
.kk.........kkkk.
k54k.......k9998k
.k544k.....k9887k
..k5kwwkkkkk9887k
...kw99NnNnk8877k
....kkkkkkkk8877k
...........k8777k
...........kkkkk.`;
const SPARKS = [
  part`
w.....y
..y.w..
.r...r.`,
  part`
..y.y..
y.....w
...r...`,
];

// A brass telescope on a tripod, aimed up and out (web search), and the arm that steadies it, 4 x 7.
const SCOPE_TUBE = part`
..............kkk.
............kkyBk.
..........kkyyyBBk
........kkyyyyrkk.
......kkyyyyrrk...
....kkyyyyrrk.....
..kkyyyyrrk.......
.kyyyyrrk.........
k7yyrrkk..........
k77kk.............
.kk...............`;
const TRIPOD = part`
....kkkkk....
....knNnk....
....kknkk....
.....nNn.....
.....nNn.....
....n.N.n....
....n.N.n....
....n.N.n....
....n.N.n....
...n..N..n...
...n..N..n...
...n..N..n...
...n..N..n...
..n...N...n..
..n...N...n..
..n...N...n..
..n...N...n..
.n....N....n.
.n....N....n.
.n....N....n.
.n....N....n.
n.....N.....n
n.....n.....n`;
const LENS_GLINT = part`w`;
const HOLD_R = part`
k99k
k98k
k54k
k54k
k54k
k44k
.kk.`;

const BANG = part`
.kkkkkk.
kwwwwwwk
kwwrrwwk
kwwrrwwk
kwwrrwwk
kwwwwwwk
kwwrrwwk
.kkkkkk.
.kk.....
k.......`;

const SPARKLE = [
  part`
..y..
..y..
yywyy
..y..
..y..`,
  part`
.....
..y..
.ywy.
..y..
.....`,
  part`
.....
.....
..w..
.....
.....`,
];

const SMOKE = [
  part`
.....88.
....8998
.88.8987
8998.88.
8987....
.88.....`,
  part`
....88..
...8998.
.88.887.
8998....
.887.88.
.....87.`,
];
const ZAP = part`
.y.
yw.
.y.`;

// ---------- Frames ----------

const SEAT_X = 14;
const SEAT_Y = 2;
const DESK_X = 4;
const DESK_Y = 24;

type Desk = { lights?: Part; scope?: Part; keys?: Part | null; extra?: Layer[]; top?: Layer[] };

// Seated at the console: hands on the keyboard (lifted 1px when typing), desk lights and scope.
function seated(face: Face, d: Desk = {}, hands: [number, number] = [0, 0], flash = false, dx = 0): Grid {
  const x = SEAT_X + dx;
  return frame(MASCOT_W, MASCOT_H, [
    ...figure(x, SEAT_Y, FACE[face], { l: null, r: null }, flash),
    [DESK, DESK_X, DESK_Y],
    [d.lights ?? LIGHTS[0], DESK_X + 14, DESK_Y + 7],
    [d.scope ?? SCOPE_FLAT, DESK_X + 4, DESK_Y + 7],
    d.keys !== null && [KEYBOARD, 15, 23],
    d.keys && [d.keys, 18, 24],
    d.keys !== null && [ARM_L, x, SEAT_Y + 17 - hands[0]],
    d.keys !== null && [ARM_R, x + 16, SEAT_Y + 17 - hands[1]],
    ...(d.extra ?? []),
    ...(d.top ?? []),
  ]);
}

const STAND_X = 6;
const STAND_Y = 4;

function standing(face: Face | Part, arms: Arms = {}, extra: Layer[] = [], dy = 0, flash = false, under: Layer[] = [], x = STAND_X): Grid {
  const f = typeof face === 'string' ? FACE[face] : face;
  return frame(MASCOT_W, MASCOT_H, [[SHADOW, x + 1, STAND_Y + 28], ...under, ...figure(x, STAND_Y - dy, f, arms, flash), ...extra]);
}

function build(): Record<Activity, Anim> {
  const mug = (i: number): Layer[] => [[MUG, 36, 19], [STEAM[i], 37, 15]];
  const typing = (face: Face, n: number, fast: boolean, extra: (i: number) => Partial<Desk> = () => ({})) =>
    Array.from({ length: n }, (_, i) =>
      seated(face, { lights: LIGHTS[i % 3], scope: SCOPE[i % 3], keys: fast ? KEY_FLASH[i % 4] : undefined, ...extra(i) }, fast ? [i % 2, (i + 1) % 2] : [i % 4 === 0 ? 1 : 0, i % 4 === 2 ? 1 : 0]),
    );
  const forge = (up: boolean, i: number) =>
    standing(
      up ? 'focus' : 'squint',
      up ? { r: [OUT_R, 16, 9] } : { r: [SWING_DOWN, 16, 15] },
      [up ? [HAMMER_UP, STAND_X + 15, STAND_Y + 1] : null, !up ? [SPARKS[i % 2], 31, 18] : null],
      0,
      false,
      [[ANVIL, 27, 26], [HOT[up ? 0 : 1], 33, 25]],
    );
  const spy = (face: Face, glint: boolean, dy = 0) =>
    standing(face, { r: [HOLD_R, 16, 11 - dy] }, [[SCOPE_TUBE, 22, 5], glint && [LENS_GLINT, 37, 6]], dy, false, [[TRIPOD, 25, 10], [SHADOW, 22, 31]], 4);

  return {
    idle: anim([seated('open', { extra: mug(0) }), seated('open', { extra: mug(1), lights: LIGHTS[3] }), seated('blink', { extra: mug(1), lights: LIGHTS[3] }), seated('open', { extra: mug(0) })], [6, 6, 1, 5]),
    think: anim(
      [0, 1, 2, 2].map((i) => seated('up', { lights: LIGHTS[3], top: [[THINK, 33, 0], [THINK_DOTS[i], 37, 3]] })),
      [3, 3, 3, 3],
    ),
    write: anim(
      typing('down', 6, false, (i) => ({ top: [[SAY, 34, 0], [SAY_LINES[Math.min(2, i >> 1)], 37, 2]], scope: SCOPE_TEXT[Math.min(2, i >> 1)] })),
      2,
    ),
    read: anim(
      [0, 0, 1, 0].map((p, i) =>
        seated('down', {
          lights: LIGHTS[3],
          keys: null,
          extra: [[BOOK, 15, 22], i === 1 && [PAGE[0], 22, 19], i === 2 && [PAGE[1], 22, 20], [ARM_L, SEAT_X, SEAT_Y + 17], [ARM_R, SEAT_X + 16, SEAT_Y + 17 - (i === 1 || i === 2 ? 1 : 0)]],
        }),
      ),
      [8, 2, 2, 8],
    ),
    edit: anim(typing('focus', 8, true, (i) => ({ top: [[GLYPHS, 35, 15 - (i % 4) * 2]] })), 1),
    work: anim(typing('down', 8, false), 1),
    shell: anim([forge(true, 0), forge(true, 0), forge(false, 0), forge(false, 1)], [3, 1, 1, 2]),
    web: anim([spy('right', true), spy('right', false), spy('right', false, 1), spy('right', false), spy('squint', false), spy('right', true)], [3, 3, 2, 3, 1, 3]),
    wait: anim(
      [
        standing('alert', { l: [UP_L, 0, 9] }, [[BANG, 27, 1]]),
        standing('alert', { l: [OUT_L, -2, 9] }, [[BANG, 27, 1]]),
        standing('alert', { l: [UP_L, 0, 9] }, [], 0, true),
        standing('alert', { l: [OUT_L, -2, 9] }, [[BANG, 27, 1]]),
      ],
      2,
      0,
    ),
    done: anim(
      [0, 1, 2, 1].map((i) =>
        standing('happy', { l: [OUT_L, -2, 9], r: [OUT_R, 16, 9] }, [[SPARKLE[i], 2, 4], [SPARKLE[(i + 1) % 3], 32, 2], [SPARKLE[(i + 2) % 3], 36, 14]], i === 1 ? 1 : 0),
      ),
      2,
    ),
    error: anim(
      [0, 1, 0, 1].map((i) =>
        seated('x', { lights: ALARM[i % 2], scope: SCOPE_ERR, top: [[SMOKE[i % 2], 28, 0], i === 0 && [ZAP, 31, 3]] }, [0, 0], false, i === 2 ? 1 : 0),
      ),
      [2, 2, 1, 3],
    ),
  };
}

let built: Record<Activity, Anim> | null = null;

export function mascotAnim(a: Activity): Anim {
  built ??= build();
  return built[a];
}

