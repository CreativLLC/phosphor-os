// Helper agents (crew) in the scene (web/src/scene.ts), 16 x 24, in the shaded scene style. Owner: art team.
// The same five crew as crew.ts, smaller and in color, light from the top left:
//   scout      (Explore)            ranger hat, green vest, magnifying glass
//   architect  (Plan)               side-part hair, glasses, blue shirt, blueprint and pencil
//   engineer   (general-purpose)    boxy robot, antenna light, wrench
//   librarian  (claude-code-guide)  red hair in a bun, brown robe, open book
//   crew       (anything else)      tech in an orange jumpsuit with a tablet; cap, headset or mohawk by name
// Each has: walk (facing left; mirrored to walk out), work, cheer (done), slump (failed) and doze (stopped).

import type { AgentStatus } from '../../../shared/protocol.ts';
import { anim, frame, part, type Anim, type Grid, type Layer, type Part } from './engine.ts';
import type { CrewKind } from './crew.ts';

export const TROUPE_W = 16;
export const TROUPE_H = 24;

const HX = 3; // head left
const HY = 5; // head top
const BY = 12; // body top
const BX = 2; // body left

// ---------- Parts ----------

const HEAD = part`
..kkkkkk..
.k333322k.
k33322221k
k32222221k
k32222221k
k22222211k
.k222111k.
..kkkkkk..`;

const ROBOT_HEAD = part`
.kkkkkkkk.
k99999998k
k9kkkkkk7k
k9oooooo7k
k9oooooo7k
k9kkkkkk7k
k88877777k
.kkkkkkkk.`;

type Face = 'open' | 'left' | 'down' | 'happy' | 'x' | 'sleep' | 'blink';
// 10 x 4 on the head, rows 3..6.
const FACE: Record<Face, Part> = {
  open: part`
...k..k...
...k..k...
..........
....11....`,
  left: part`
..k..k....
..k..k....
..........
...11.....`,
  down: part`
..........
...k..k...
..........
....11....`,
  happy: part`
..k....k..
.k.k..k.k.
..........
...k11k...`,
  x: part`
..k.kk.k..
...k..k...
..k.kk.k..
....11....`,
  sleep: part`
..........
..kk..kk..
..........
....11....`,
  blink: part`
..........
..kk..kk..
..........
....11....`,
};

// Body with arms down, 12 x 9. A light cloth, D shade, P trousers: swapped per crew member.
const BODY = part`
...kkkkkk...
..kAAAAADk..
.kAkAAAADkDk
.kAkAAADDkDk
.k2kAADDDk1k
..kkPPPPPkk.
...kPPkPPk..
...kPPkPPk..
...kkk.kkk..`;
const STRIDE = [
  part`
...kPPkPPk..
..kPPk.kPPk.
..kkk...kkk.`,
  part`
...kPPPPPk..
....kPPPk...
....kkkkk...`,
];
// Arms: one raised (cheer), hands to the front (holding a prop).
const RAISE_L = part`
.kk.
k32k
k22k
kAAk
kAAk
kADk
.kk.`;
const RAISE_R = part`
.kk.
k21k
k11k
kADk
kDDk
kDDk
.kk.`;
const FRONT = part`
...kkkkkk...
..kAAAAADk..
.kAAAAAADDk.
.kAkAADDkDk.
..k2kDDk1k..
..kkPPPPPkk.`;

const SHADOW = part`
..kkkkkkkk..
.kkkkkkkkkk.`;

type Look = { A: string; D: string; P: string; hair: Layer[]; robot?: boolean };
const paint = (p: Part, l: Look): Part => p.map((r) => r.replaceAll('A', l.A).replaceAll('D', l.D).replaceAll('P', l.P));

// Hair and hats, drawn over the head (x from the sprite's left edge).
const RANGER = part`
....kkkkkk....
...kNNNNNnk...
...knnnnnnk...
.kkNNNNNNNNnkk
knnnnnnnnnnnnk
.kkkkkkkkkkkk.`;
const SIDE_PART = part`
..kkkkkk..
.kNNNnnnk.
kNNknnnnnk
kNk.kkkknk
kk......kk`;
const GLASSES = part`
.kkk..kkk.
.kwk..kwk.`;
const BUN = part`
...kkkk...
..krryrk..
..kkkkkk..
.krrryrrk.
krrrkkrrrk
krk....krk
kk......kk`;
const CAP = part`
..kkkkkk....
.kBBBBBbk...
kBBBBBBBbkkk
kkkkkkkkkbbk`;
const HEADSET = part`
..kkkkkk..
.k......k.
k9......9k
k8......8k`;
const MOHAWK = part`
....kk....
...krk....
...krrk...
..kkrrkk..`;
const BUZZ = part`
..kkkkkk..
.knnnnnnk.
knk....knk`;
const ANTENNA = part`
.kk.
kryk
.kk.
.k..`;

// Props, held in front.
const LENS = [
  part`
.kkkkk.
k9BBw9k
k9bBB9k
.kkkkk.
....knk
.....kk`,
  part`
.kkkkk.
k9BB99k
k9bBB9k
.kkkkk.
....knk
.....kk`,
];
const PRINT = part`
kkkkkkkkkk
kBBBBBBBBk
kBwwwBwBBk
kBwBBBwBBk
kBwwwwwBbk
kbbbbbbbbk
kkkkkkkkkk`;
const PENCIL = [part`
.y
kn`, part`
y.
nk`];
const BOOK = part`
kkkkkkkkkk
kwwwwkwwwk
kw88wkw88k
kwwwwkwwwk
kbbbbkbbbk
kkkkkkkkkk`;
const PAGE = part`
kk
wk
wk`;
const WRENCH = [
  part`
kk.kk
k9k9k
k998k
.k8k.
.k8k.
.k7k.
.kkk.`,
  part`
.kk.kk
k9kk9k
.k998k
.k88k.
k88k..
k7k...
kk....`,
];
const TABLET = [
  part`
kkkkkkkk
k7cccc7k
k7cCcc7k
k7cccc7k
kkkkkkkk`,
  part`
kkkkkkkk
k7cccC7k
k7cccc7k
k7Cccc7k
kkkkkkkk`,
];
const SMOKE = [part`
.88.
8998
.887`, part`
..88
.898
8987`];
const ZZ = [part`
kkk
.k.
kkk`, part`
.....
kkk..
.k...
kkk..`];
const STAR = [part`
.y.
ywy
.y.`, part`
...
.w.
...`];

// ---------- Frames ----------

type Pose = { face: Face; dy?: number; legs?: Part; body?: Part; arms?: Layer[]; front?: Layer[]; back?: Layer[]; robotEyes?: string };

function draw(l: Look, p: Pose): Grid {
  const dy = p.dy ?? 0;
  const face = FACE[p.face];
  return frame(TROUPE_W, TROUPE_H, [
    [SHADOW, BX, 20],
    ...(p.back ?? []),
    [paint(p.body ?? BODY, l), BX, BY - dy],
    p.legs && [paint(p.legs, l), BX, BY + 6],
    ...(p.arms ?? []).map((a) => a && ([paint(a[0], l), a[1], a[2] - dy] as Layer)),
    ...(l.robot
      ? [[ROBOT_HEAD, HX, HY - dy] as Layer, [robotFace(p), HX + 2, HY + 3 - dy] as Layer]
      : [[HEAD, HX, HY - dy] as Layer, [face, HX, HY + 3 - dy] as Layer]),
    ...l.hair.map((h) => h && ([h[0], h[1], h[2] - dy] as Layer)),
    ...(p.front ?? []).map((f) => f && ([f[0], f[1], f[2] - dy] as Layer)),
  ]);
}

// The robot's visor: two lamp eyes, or what its mood shows.
function robotFace(p: Pose): Part {
  const e = p.robotEyes ?? 'G';
  const row = p.face === 'x' ? 'r.rr.r' : p.face === 'sleep' ? '......' : p.face === 'happy' ? '.y..y.' : p.face === 'left' ? `${e}..${e}..` : `.${e}..${e}.`;
  return p.face === 'sleep' ? ['......', '-o..-o'] : p.face === 'happy' ? ['y....y', '.y..y.'] : [row, row];
}

const LOOKS: Record<Exclude<CrewKind, 'crew'>, Look> = {
  scout: { A: 'G', D: 'g', P: 'n', hair: [[RANGER, 1, 1]] },
  architect: { A: 'B', D: 'b', P: '7', hair: [[SIDE_PART, HX, 3], [GLASSES, HX, HY + 3]] },
  engineer: { A: '9', D: '8', P: '7', hair: [[ANTENNA, HX + 3, 2]], robot: true },
  librarian: { A: 'N', D: 'n', P: 'n', hair: [[BUN, HX, 1]] },
};
const CREW_HAIR: Layer[][] = [[[CAP, HX, 3]], [[BUZZ, HX, 4], [HEADSET, HX, 5]], [[MOHAWK, HX, 1], [BUZZ, HX, 4]]];
export const TROUPE_LOOKS = CREW_HAIR.length;
const crewLook = (i: number): Look => ({ A: '6', D: '5', P: '7', hair: CREW_HAIR[i % CREW_HAIR.length] });

function working(kind: CrewKind, l: Look): Anim {
  const hold = (face: Face, front: Layer[], dy = 0): Grid => draw(l, { face, dy, body: FRONT, legs: STRIDE[1], front });
  switch (kind) {
    case 'scout':
      return anim(
        [0, 1, 2, 1].map((i) => hold(i === 2 ? 'left' : 'down', [[LENS[i % 2], 7 + (i === 2 ? -3 : i === 0 ? 1 : -1), 14]])),
        [3, 2, 3, 2],
      );
    case 'architect':
      return anim([0, 1, 0, 1].map((i, n) => hold('down', [[PRINT, 3, 15], [PENCIL[i], 7 + (n >> 1) * 2, 16]])), 2);
    case 'engineer':
      return anim(
        [0, 1, 0, 1].map((i, n) =>
          draw(l, { face: 'open', legs: STRIDE[1], arms: [[RAISE_R, 12, 8 + i]], front: [[WRENCH[i], 12 - i, 3 + i], n === 1 && [STAR[0], 2, 12]], robotEyes: i ? 'y' : 'G' }),
        ),
        3,
      );
    case 'librarian':
      return anim([0, 0, 1].map((i) => hold('down', [[BOOK, 3, 16], i ? [PAGE, 7, 14] : null])), [4, 4, 2]);
    default:
      return anim([0, 1].map((i) => hold(i ? 'down' : 'open', [[TABLET[i], 4, 16]])), 3);
  }
}

function walking(l: Look): Anim {
  return anim([0, 1, 0, 1].map((i, n) => draw(l, { face: 'left', dy: i, legs: STRIDE[n === 0 ? 0 : 1] })), 1);
}

function cheer(l: Look): Anim {
  return anim(
    [0, 1].map((i) => draw(l, { face: 'happy', dy: i, legs: STRIDE[1], arms: [[RAISE_L, 0, 7], [RAISE_R, 12, 7]], front: [[STAR[i], 0, 4], [STAR[1 - i], 13, 2]] })),
    2,
  );
}

function slump(l: Look, failed: boolean): Anim {
  return anim(
    [0, 1].map((i) => draw(l, { face: failed ? 'x' : 'sleep', dy: -1, legs: STRIDE[1], front: [failed ? [SMOKE[i], 11, 0] : [ZZ[i], 11, 0]] })),
    3,
  );
}

export type TroupeMove = 'walk' | 'work' | AgentStatus;

const cache = new Map<string, Anim>();

// walk = walking in (facing left); 'walk' with out = walking out (facing right).
export function troupeAnim(kind: CrewKind, look: number, move: TroupeMove, out = false): Anim {
  const key = `${kind}/${look}/${move}/${out}`;
  let a = cache.get(key);
  if (!a) {
    const l = kind === 'crew' ? crewLook(look) : LOOKS[kind];
    a =
      move === 'walk'
        ? walking(l)
        : move === 'work' || move === 'running'
          ? working(kind, l)
          : move === 'completed'
            ? cheer(l)
            : slump(l, move === 'failed');
    if (out) a = anim(a.frames.map(flip), a.ends.map((e, i) => e - (a!.ends[i - 1] ?? 0)), a.still);
    cache.set(key, a);
  }
  return a;
}

function flip(g: Grid): Grid {
  const px = new Uint8Array(g.px.length);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) px[y * g.w + x] = g.px[y * g.w + (g.w - 1 - x)];
  return { w: g.w, h: g.h, px };
}
