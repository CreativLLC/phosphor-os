// Main operator sprite, 32 x 32. Owner: art team.
// The main Claude as a ship's terminal: a monitor-headed operator with rabbit-ear antennas
// and a high-collar flight jacket, sitting at a console with a keyboard, status lights, a scope
// and a steaming mug.
//   idle     blinks, mug steams, one status light breathes
//   working  types fast, eyes on the keys, lights chase, the scope draws a wave
//   alert    waves an arm, a "!" bubble blinks and the screen flashes (Claude needs you)

import { anim, frame, part, type Anim, type Layer, type Part } from './engine.ts';

// The face on the screen glows in the accent color ('c'): one small splash of color.
const tint = (p: Part): Part => p.map((r) => r.replaceAll('@', 'c'));

export type OperatorState = 'idle' | 'working' | 'alert';

const W = 32;

const ANTENNA = part`
@......@
.+....+.
..+..+..
..####..`;

const MONITOR = part`
.##################.
####################
###oooooooooooooo###
##oooooooooooooooo##
##oooooooooooooooo##
##oooooooooooooooo##
##oooooooooooooooo##
##oooooooooooooooo##
##oooooooooooooooo##
###oooooooooooooo###
####################
##+#+#+#########@###
.##################.`;

// Screen faces: 16 x 8 overlays at the screen corner (8, 6).
const GLARE = part`
.+
+.`;
const FACE_OPEN = tint(part`
................
....@@....@@....
....@@....@@....
....@@....@@....
................
....@......@....
.....@@@@@@.....
................`);
const FACE_BLINK = tint(part`
................
................
................
....@@....@@....
................
....@......@....
.....@@@@@@.....
................`);
const FACE_DOWN_A = tint(part`
................
................
....@@....@@....
....@@....@@....
................
................
......@@@@......
................`);
const FACE_DOWN_B = tint(part`
................
................
....@@....@@....
....@@....@@....
................
.......@@.......
......@..@......
.......@@.......`);
const FACE_ALERT = tint(part`
...@@@....@@@...
...@o@....@o@...
...@@@....@@@...
................
.......@@.......
......@..@......
.......@@.......
................`);
const FLASH = part`
.@@@@@@@@@@@@@@.
@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@
.@@@@@@@@@@@@@@.`;
const FACE_ALERT_DARK = FACE_ALERT.map((r) => r.replaceAll('c', '1').replaceAll('o', '@').replaceAll('1', 'o'));

const BODY = part`
........++++........
....++##++++##++....
..++++++#++#++++++..
.+++o++++##++++o+++.
.+++o++++##++++o+++.
.+++o++++##++++o+++.
.+++o++++##++++o+++.`;
const NO_LEFT_ARM = part`
xxxx
xxxx
xxxx
xxxx`;

const HAND = part`
@@@
@@@`;

const KEYS = part`.@+@+@+@+@+@+@+@+@.`;

const CONSOLE = part`
################################
#oooooooooooooooooooooooooooooo#
#oooooooooooooooooooo########oo#
#oooooooooooooooooooo#oooooo#oo#
#o+++++ooooooooooooo##oooooo#oo#
#oooooooooooooooooooo########oo#
################################`;

const LIGHTS = [part`@.+.+`, part`+.@.+`, part`+.+.@`, part`+.+.+`];
const SCOPE_FLAT = part`
......
++++++
......`;
const SCOPE = [
  part`
.@...@
@.@.@.
...@..`,
  part`
@...@.
.@.@.@
..@...`,
  part`
...@..
@.@.@.
.@...@`,
  part`
..@...
.@.@.@
@...@.`,
];

const MUG = part`
####.
#++##
#++#.
####.`;
const STEAM = [
  part`
.+..
..+.
.+..`,
  part`
..+.
.+..
..+.`,
];

// Waving arm (left side), two positions, and the "!" bubble.
const WAVE_A = part`
@.@.@.....
@@@@@.....
.@@@@.....
..++......
..++......
...++.....
...++.....
...++.....
...++.....
...++.....
...++.....
...++.....
....++....
.....++...
......+++.
.......++.`;
const WAVE_B = part`
..@.@.@...
..@@@@@...
..@@@@....
...++.....
...++.....
...++.....
...++.....
...++.....
...++.....
...++.....
...++.....
...++.....
....++....
.....++...
......+++.
.......++.`;
const BUBBLE = part`
.####.
#o@@o#
#o@@o#
#o@@o#
#o@@o#
#oooo#
#o@@o#
.####.
##....
#.....`;

type Look = {
  face: Part;
  dark?: boolean; // flashed screen
  handL?: number; // hand lift (typing)
  handR?: number;
  wave?: Part; // left arm raised instead of typing
  lights: Part;
  scope: Part;
  steam?: Part;
  over?: Layer[];
};

function draw(l: Look) {
  return frame(W, W, [
    [ANTENNA, 12, 0],
    [MONITOR, 6, 4],
    l.dark && [FLASH, 8, 6],
    !l.dark && [GLARE, 9, 6],
    [l.face, 8, 6],
    [BODY, 6, 17],
    l.wave && [NO_LEFT_ARM, 7, 20],
    l.wave ? [l.wave, 0, 4] : [HAND, 9, 22 - (l.handL ?? 0)],
    [HAND, 20, 22 - (l.handR ?? 0)],
    [MUG, 26, 20],
    l.steam && [l.steam, 26, 17],
    [KEYS, 7, 24],
    [CONSOLE, 0, 25],
    [l.lights, 3, 28],
    [l.scope, 22, 28],
    ...(l.over ?? []),
  ]);
}

let built: Record<OperatorState, Anim> | null = null;

export function operatorAnim(state: OperatorState): Anim {
  built ??= {
    idle: anim(
      [
        draw({ face: FACE_OPEN, lights: LIGHTS[0], scope: SCOPE_FLAT, steam: STEAM[0] }),
        draw({ face: FACE_OPEN, lights: LIGHTS[0], scope: SCOPE_FLAT, steam: STEAM[1] }),
        draw({ face: FACE_OPEN, lights: LIGHTS[3], scope: SCOPE_FLAT, steam: STEAM[0] }),
        draw({ face: FACE_BLINK, lights: LIGHTS[3], scope: SCOPE_FLAT, steam: STEAM[1] }),
        draw({ face: FACE_OPEN, lights: LIGHTS[3], scope: SCOPE_FLAT, steam: STEAM[1] }),
        draw({ face: FACE_OPEN, lights: LIGHTS[0], scope: SCOPE_FLAT, steam: STEAM[0] }),
      ],
      [5, 5, 5, 1, 4, 5],
    ),
    working: anim(
      [0, 1, 2, 3, 0, 1, 2, 3].map((i, n) =>
        draw({
          face: n === 5 ? FACE_DOWN_B : FACE_DOWN_A,
          handL: n % 2 ? 0 : 1,
          handR: n % 2 ? 1 : 0,
          lights: LIGHTS[n % 3],
          scope: SCOPE[i],
          steam: STEAM[n >> 2],
        }),
      ),
      1,
    ),
    alert: anim(
      [
        draw({ face: FACE_ALERT, wave: WAVE_A, lights: LIGHTS[0], scope: SCOPE_FLAT, over: [[BUBBLE, 26, 0]] }),
        draw({ face: FACE_ALERT, wave: WAVE_B, lights: LIGHTS[2], scope: SCOPE_FLAT, over: [[BUBBLE, 26, 0]] }),
        draw({ face: FACE_ALERT_DARK, dark: true, wave: WAVE_A, lights: LIGHTS[0], scope: SCOPE_FLAT }),
        draw({ face: FACE_ALERT, wave: WAVE_B, lights: LIGHTS[2], scope: SCOPE_FLAT, over: [[BUBBLE, 26, 0]] }),
      ],
      2,
    ),
  };
  return built[state];
}
