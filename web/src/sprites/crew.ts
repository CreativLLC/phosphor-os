// Subagent crew sprites, 24 x 24. Owner: art team.
// Original characters, drawn as text grids (legend in engine.ts):
//   scout      (Explore)            ranger hat, magnifying glass
//   architect  (Plan)               side-part hair, square glasses, pencil, blueprint
//   engineer   (general-purpose)    boxy robot with antenna and wrench
//   librarian  (claude-code-guide)  hair bun, open book
//   crew       (anything else)      tech in a jumpsuit; cap, headset or mohawk picked from the name
// Every one has a working loop (running), a thumbs-up (completed), a slump with X eyes and
// smoke (failed) and a sit-down nap (stopped).

import type { AgentStatus } from '../../../shared/protocol.ts';
import { anim, frame, mirror, part, type Anim, type Grid, type Layer, type Part } from './engine.ts';

export type CrewKind = 'scout' | 'architect' | 'engineer' | 'librarian' | 'crew';

const W = 24;
const HY = 3; // head top
const BY = 13; // shoulders
const LY = 19; // hips

// ---------- Shared body parts ----------

const HEAD = part`
....######....
...########...
..##########..
..##########..
.############.
##############
##############
..##########..
...########...
....######....`;

const ROBOT_HEAD = part`
..##########..
.############.
.############.
.#oooooooooo#.
.#oooooooooo#.
.#oooooooooo#.
+############+
.##+#+#+#+###.
.############.
..##########..`;

type Expr = 'open' | 'blink' | 'down' | 'right' | 'happy' | 'wink' | 'x' | 'sleepy';

// Faces: 12 x 10 overlays at (6, head top).
const FACE: Record<Expr, Part> = {
  open: part`
............
............
............
............
...o....o...
...o....o...
............
...o....o...
....oooo....
............`,
  blink: part`
............
............
............
............
............
...oo..oo...
............
...o....o...
....oooo....
............`,
  down: part`
............
............
............
............
............
...o....o...
...o....o...
............
.....oo.....
............`,
  right: part`
............
............
............
............
....o....o..
....o....o..
............
....o...o...
.....ooo....
............`,
  happy: part`
............
............
............
............
...o....o...
..o.o..o.o..
............
...oooooo...
....o++o....
............`,
  wink: part`
............
............
............
............
........o...
..ooo...o...
............
...oooooo...
....o++o....
............`,
  x: part`
............
............
............
..o.o..o.o..
...o....o...
..o.o..o.o..
............
....oooo....
...o....o...
............`,
  sleepy: part`
............
............
............
............
............
..ooo..ooo..
............
............
.....oo.....
............`,
};

// Robot faces live in the visor (rows 3-5) and use lit pixels.
const ROBOT_FACE: Record<Expr, Part> = {
  open: part`
............
............
............
............
..@@....@@..
............`,
  blink: part`
............
............
............
............
..++....++..
............`,
  down: part`
............
............
............
............
............
..@@....@@..`,
  right: part`
............
............
............
............
...@@....@@.
............`,
  happy: part`
............
............
............
...@....@...
..@.@..@.@..
............`,
  wink: part`
............
............
............
........@...
..@@...@.@..
............`,
  x: part`
............
............
............
..@.@..@.@..
...@....@...
..@.@..@.@..`,
  sleepy: part`
............
............
............
............
............
..++....++..`,
};

const ARM_L = part`
.+
++
##
##
##`;
const ARM_R = mirror(ARM_L);
const ROBOT_ARM_L = part`
.+
++
++
++
##`;
const ROBOT_ARM_R = mirror(ROBOT_ARM_L);

// Right arm raised, thumb up. At (16, 5).
const THUMB = part`
.....#.
.....#.
....###
....###
....##.
...##..
...##..
..++...
+++....`;
const ROBOT_THUMB = part`
.....#.
.....#.
....###
....###
....++.
...++..
...++..
..++...
+++....`;

const LEGS = part`
.++..++.
.++..++.
.++..++.
###..###`;
const LEGS_A = part`
.++..++.
.++..++.
.##..++.
.....###`;
const LEGS_B = part`
.++..++.
.++..++.
.++..##.
###.....`;
// Sitting cross-legged. At (6, 21).
const LEGS_SIT = part`
.++++++++++.
++++++++++++
.###....###.`;

// ---------- Effects ----------

const SPARK_S = part`
.@.
@@@
.@.`;
const SPARK_L = part`
..@..
..@..
@@#@@
..@..
..@..`;
const SMOKE_A = part`
.++.
+..+
.++.`;
const SMOKE_B = part`
.+.
+.+
.+.`;
const Z_BIG = part`
@@@@@
...@.
..@..
.@...
@@@@@`;
const Z_SMALL = part`
####
..#.
.#..
####`;

// ---------- Characters ----------

type Pose = {
  dy?: number; // drop of the upper body (bob, slump, sit)
  hdy?: number; // extra drop of the head (slumped)
  legs?: Part;
  face: Expr;
  armL?: Part | null; // null hides the arm (a prop covers it)
  armR?: Part | null;
  under?: Layer[]; // drawn before the body
  over?: Layer[]; // drawn after everything (props, effects)
};

type Def = {
  robot?: boolean;
  torso: Part;
  drop?: Part; // prop lying on the floor after a failure
  top?: (y: number, p: Pose) => Layer[]; // hair, hats, glasses; y = head top
};

function draw(d: Def, p: Pose): Grid {
  const dy = p.dy ?? 0;
  const hy = HY + dy + (p.hdy ?? 0);
  const armL = p.armL === undefined ? (d.robot ? ROBOT_ARM_L : ARM_L) : p.armL;
  const armR = p.armR === undefined ? (d.robot ? ROBOT_ARM_R : ARM_R) : p.armR;
  const sitting = p.legs === LEGS_SIT;
  return frame(W, W, [
    ...(p.under ?? []),
    [p.legs ?? LEGS, sitting ? 6 : 8, sitting ? 21 : LY],
    [d.torso, 8, BY + dy],
    armL && [armL, 6, BY + dy],
    armR && [armR, 16, BY + dy],
    [d.robot ? ROBOT_HEAD : HEAD, 5, hy],
    [(d.robot ? ROBOT_FACE : FACE)[p.face], 6, hy],
    ...(d.top ? d.top(hy, p) : []),
    ...(p.over ?? []),
  ]);
}

const TORSO_SUIT = part`
+++##+++
++++++++
++@+++++
oooooooo
++++++++
.++++++.`;

// Scout: ranger hat, neckerchief.
const SCOUT_HAT = part`
.....######.....
....########....
....oooooooo....
@@@@@@@@@@@@@@@@
@..............@`;
const scout: Def = {
  torso: part`
++@##@++
+++@@+++
++++@+++
oooooooo
++++++++
.++++++.`,
  top: (y) => [[SCOUT_HAT, 4, y - 3]],
  drop: part`
.###..
#ooo#.
#o@o#.
.###+.
....++`,
};

// Magnifier held out to the right (at 16, 6), and held up to the eye (at 11, 4).
const LENS_OUT = part`
...###.
..#oo@#
..#ooo#
..#ooo#
...###.
....+..
...##..
++###..
++.....`;
const LENS_OUT_GLINT = part`
...###.
..#@oo#
..#ooo#
..#ooo#
...###.
....+..
...##..
++###..
++.....`;
const LENS_EYE = part`
..#####..
.#######.
.##ooo##.
.##o@o##.
.##ooo##.
.#######.
..#####+.
.......++
......##.
.....##..
....++...`;

// Architect: side part, square glasses, pencil behind the ear, shirt and tie.
const ARCH_HAIR = part`
...++++++...
..++++++++..
.+++++++o++.
.+.....+++..`;
const GLASSES = part`
..@@@..@@@..
..@.@@@@.@..
..@@@..@@@..`;
const PENCIL_EAR = part`
@
@
+`;
const architect: Def = {
  torso: part`
++#@@#++
+++@@+++
+++@@+++
ooo@@ooo
++++++++
.++++++.`,
  top: (y, p) => [[ARCH_HAIR, 6, y], p.face !== 'x' && [GLASSES, 6, y + 3], [PENCIL_EAR, 18, y + 2]],
  drop: part`
.####.
#++@+#
.####.`,
};

// Blueprint held in front, a house drawn line by line. Sheet at (7, 14).
const SHEET = part`
##########
#++++++++#
#++++++++#
#++++++++#
#++++++++#
#++++++++#
##########`;
const HOUSE = [
  part`
........
........
........
........
.@@@@@@.`,
  part`
........
........
.@@@@@@.
.@....@.
.@@@@@@.`,
  part`
...@@...
..@..@..
.@@@@@@.
.@....@.
.@@@@@@.`,
  part`
...@@...
..@..@..
.@@@@@@.
.@..@.@.
.@@@@@@.`,
];
const PENCIL_HAND = part`
..##
..##
.@..
@...`;
const GRIP = part`
##
##`;

// Engineer: boxy robot, antenna, chest lights, wrench.
const ANTENNA_ON = part`
@
+
+`;
const ANTENNA_OFF = part`
+
+
+`;
const engineer: Def = {
  robot: true,
  torso: part`
++++++++
+######+
+#@#+#@#
+######+
++++++++
.++++++.`,
  top: (y, p) => [[p.face === 'blink' || p.face === 'sleepy' || p.face === 'x' ? ANTENNA_OFF : ANTENNA_ON, 14, y - 3]],
  drop: part`
@.@....
.@@@@@@
@.@....`,
};
// Wrench swing: raised (at 16, 2), then down on the machine (at 16, 13). Machine at (19, 20).
const WRENCH_UP = part`
.....@.@
.....@@@
....@@..
...@@...
..###...
..###...
..++....
..++....
..++....
.++.....
++......
++......`;
const WRENCH_DOWN = part`
++......
.++.....
..###...
..###@..
......@.
.....@@@
.....@.@`;
const MACHINE = part`
.###.
#+@+#
#+++#
#####`;
const MACHINE_LIT = part`
.###.
#@@@#
#+++#
#####`;

// Librarian: two hair buns, straight bangs, round glasses, cardigan, book.
const BUNS = part`
.++..........++.
++++........++++
++++.++++++.++++
.+++++++++++++++
..+++++++++++++.
...++++++++++...
..++........++..
..+..........+..`;
const ROUND_GLASSES = part`
..@@....@@..
.@..@@@@..@.
..@@....@@..`;
const librarian: Def = {
  torso: part`
+++##+++
++#++#++
++@++@++
++#++#++
++@++@++
.++++++.`,
  top: (y, p) => [[BUNS, 4, y - 2], p.face !== 'x' && [ROUND_GLASSES, 6, y + 3]],
  drop: part`
######
@@@@@#
######`,
};
const BOOK = part`
.@@@@..@@@@.
@@@@@++@@@@@
@oo@o++@ooo@
@@@@@++@@@@@
@o@oo++o@o@@
############`;
const PAGE_R = part`
.@@
@@@
@@.
@@.
@@.`;
const PAGE_UP = part`
@@
@@
@@
@@
@@`;
const PAGE_L = mirror(PAGE_R);

// Crew: three looks, picked from the agent name.
const CAP = part`
...++++++.....
..++++@+++....
.++++++++++...
.+++++++++@@@@`;
const HEADSET = part`
....@@@@@@....
..@@......@@..
.@..........@.
.@..........@.
@@..........@@
@@..........@@
@@..........@@
@@..........@@`;
const BUZZ = part`
...++++++...
..++++++++..
.++++++++++.`;
const MOHAWK = part`
.....@.@....
....@@@@....
.....@@@....
....@@@@....
....+@@+....`;
const PAD_DROP = part`
#####
#o@o#
#####`;
const crewLooks: Def[] = [
  { torso: TORSO_SUIT, top: (y) => [[CAP, 6, y - 1]], drop: PAD_DROP },
  { torso: TORSO_SUIT, top: (y) => [[BUZZ, 6, y], [HEADSET, 4, y]], drop: PAD_DROP },
  { torso: TORSO_SUIT, top: (y) => [[MOHAWK, 6, y - 3]], drop: PAD_DROP },
];
const PAD = [
  part`
######
#oooo#
#@@oo#
#oooo#
######`,
  part`
######
#oooo#
#@@@o#
#@ooo#
######`,
  part`
######
#@@oo#
#@@@o#
#@@@@#
######`,
  part`
######
#@ooo#
#oooo#
#oooo#
######`,
];

// ---------- Animations ----------

function poses(d: Def, list: Pose[], hold: number | number[], still = 0): Anim {
  return anim(
    list.map((p) => draw(d, p)),
    hold,
    still,
  );
}

function done(d: Def): Anim {
  const thumb: Layer = [d.robot ? ROBOT_THUMB : THUMB, 16, 5];
  const base: Pose = { face: 'happy', armR: null, over: [thumb] };
  return poses(
    d,
    [
      { ...base, over: [thumb, [SPARK_L, 19, 0]] },
      { ...base, over: [thumb, [SPARK_S, 20, 1]] },
      { ...base },
      { ...base, face: 'wink' },
      { ...base },
    ],
    [2, 2, 8, 4, 8],
    0,
  );
}

// Slumped on the floor, X eyes, smoke and sparks, the tool dropped beside.
function failed(d: Def): Anim {
  const drop: Layer = d.drop && [d.drop, 18, 24 - d.drop.length];
  const base: Pose = { dy: 3, hdy: 1, face: 'x', legs: LEGS_SIT };
  return poses(
    d,
    [
      { ...base, over: [drop, [SMOKE_B, 9, 2]] },
      { ...base, over: [drop, [SMOKE_A, 8, 0], [SMOKE_B, 14, 2]] },
      { ...base, over: [drop, [SMOKE_B, 8, -1], [SMOKE_A, 14, 0], [SPARK_S, 18, 3]] },
      { ...base, over: [drop, [SMOKE_B, 14, -1]] },
    ],
    [3, 3, 2, 3],
  );
}

// Sitting down for a nap.
function stopped(d: Def): Anim {
  const base: Pose = { dy: 3, face: 'sleepy', legs: LEGS_SIT };
  return poses(
    d,
    [
      { ...base, over: [[Z_SMALL, 17, 4]] },
      { ...base, over: [[Z_SMALL, 18, 2]] },
      { ...base, over: [[Z_BIG, 18, 0], [Z_SMALL, 16, 5]] },
      { ...base, over: [[Z_SMALL, 17, 4]] },
    ],
    4,
  );
}

function working(kind: CrewKind, d: Def): Anim {
  switch (kind) {
    case 'scout':
      return poses(
        d,
        [
          { face: 'right', legs: LEGS_A, armR: null, over: [[LENS_OUT, 16, 6]] },
          { face: 'right', dy: 1, armR: null, over: [[LENS_OUT_GLINT, 16, 7]] },
          { face: 'right', legs: LEGS_B, armR: null, over: [[LENS_OUT, 16, 6]] },
          { face: 'right', dy: 1, armR: null, over: [[LENS_OUT_GLINT, 16, 7]] },
          { face: 'right', armR: null, over: [[LENS_EYE, 11, 4]] },
          { face: 'right', armR: null, over: [[LENS_EYE, 11, 4]] },
        ],
        [2, 2, 2, 2, 5, 1],
      );
    case 'architect': {
      const sheet: Layer = [SHEET, 7, 14];
      const tips = [
        [8, 18],
        [14, 18],
        [14, 16],
        [12, 15],
        [12, 17],
      ];
      return poses(
        d,
        tips.map(([x, y], i) => ({
          face: 'down' as Expr,
          dy: i % 2,
          armL: null,
          armR: null,
          over: [sheet, i > 0 && ([HOUSE[i - 1], 8, 15] as Layer), [GRIP, 6, 16], [PENCIL_HAND, x - 0, y - 3]],
        })),
        [2, 2, 2, 2, 4],
      );
    }
    case 'engineer':
      return poses(
        d,
        [
          { face: 'right', armR: null, under: [[MACHINE, 19, 20]], over: [[WRENCH_UP, 16, 2]] },
          { face: 'down', dy: 1, armR: null, under: [[MACHINE_LIT, 19, 20]], over: [[WRENCH_DOWN, 16, 14], [SPARK_L, 19, 15]] },
          { face: 'down', dy: 1, armR: null, under: [[MACHINE, 19, 20]], over: [[WRENCH_DOWN, 16, 14], [SPARK_S, 22, 15]] },
          { face: 'right', armR: null, under: [[MACHINE, 19, 20]], over: [[WRENCH_DOWN, 16, 13]] },
        ],
        [3, 2, 2, 1],
      );
    case 'librarian': {
      const book: Layer = [BOOK, 6, 14];
      const base: Pose = { face: 'down', armL: null, armR: null };
      return poses(
        d,
        [
          { ...base, over: [book] },
          { ...base, face: 'right', over: [book] },
          { ...base, over: [book, [PAGE_R, 12, 10]] },
          { ...base, over: [book, [PAGE_UP, 11, 9]] },
          { ...base, over: [book, [PAGE_L, 9, 10]] },
        ],
        [4, 4, 1, 1, 1],
      );
    }
    default:
      return poses(
        d,
        PAD.map((pad, i) => ({
          face: (i === 3 ? 'blink' : 'down') as Expr,
          dy: i % 2,
          armL: null,
          armR: null,
          over: [[pad, 9, 14 + (i % 2)] as Layer, [GRIP, 7, 15 + (i % 2)] as Layer, [GRIP, 15, 15 + (i % 2) - (i === 1 ? 1 : 0)] as Layer],
        })),
        [2, 2, 2, 2],
      );
  }
}

// ---------- Public ----------

const DEFS: Record<Exclude<CrewKind, 'crew'>, Def> = { scout, architect, engineer, librarian };

export function crewKind(name: string): CrewKind {
  const n = name.toLowerCase();
  if (n === 'explore' || n.includes('scout') || n.includes('search')) return 'scout';
  if (n === 'plan' || n.includes('architect') || n.includes('planner')) return 'architect';
  if (n === 'general-purpose' || n.includes('engineer') || n.includes('build')) return 'engineer';
  if (n === 'claude-code-guide' || n.includes('guide') || n.includes('librar') || n.includes('doc')) return 'librarian';
  return 'crew';
}

// Stable small number from a name, so the same agent type always gets the same look.
export function nameHash(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const CREW_LOOKS = crewLooks.length;
const cache = new Map<string, Anim>();

export function crewAnim(kind: CrewKind, look: number, status: AgentStatus): Anim {
  const key = `${kind}/${look}/${status}`;
  let a = cache.get(key);
  if (!a) {
    const d = kind === 'crew' ? crewLooks[look % crewLooks.length] : DEFS[kind];
    a = status === 'running' ? working(kind, d) : status === 'completed' ? done(d) : status === 'failed' ? failed(d) : stopped(d);
    cache.set(key, a);
  }
  return a;
}
