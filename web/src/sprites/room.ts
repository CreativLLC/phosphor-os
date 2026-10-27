// The scene's room (web/src/scene.ts): back wall, a window with stars, the floor. Owner: art team.
// Built for any width (the left panel's), 36 high, in the shaded scene style. Light from the top left.

import { anim, frame, part, type Anim, type Layer, type Part } from './engine.ts';

export const ROOM_H = 36;
export const FLOOR_Y = 24; // first floor row; the wall is above

const WINDOW = part`
.kkkkkkkkkkkkkkkkkk.
k999999999999999998k
k9kkkkkkkkkkkkkkkk7k
k9kooooooooooooook7k
k9kooooooooooooook7k
k9kooooooooooooook7k
k9kooooooooooooook7k
k9kooooooooooooook7k
k9kooooooooooooook7k
k9kkkkkkkkkkkkkkkk7k
k877777777777777777k
.kkkkkkkkkkkkkkkkkk.`;

// Stars in the window (two twinkle frames), 14 x 6 inside the frame.
const STARS = [
  part`
..w.......B...
........w.....
.B............
......w...bB..
..........BB.w
w....B........`,
  part`
..B.......w...
........B.....
.w............
......B...bB..
..........BB.B
B....w........`,
];

const LAMP = [part`
kkk
kyk
kkk`, part`
kkk
krk
kkk`];


function rows(w: number): Part {
  const out: string[] = [];
  for (let y = 0; y < ROOM_H; y++) {
    let r = '';
    for (let x = 0; x < w; x++) {
      let c: string;
      if (y === 0) c = 'k';
      else if (y < 3) c = 'Z';
      else if (y === 3) c = 'k';
      else if (y < FLOOR_Y - 2) c = x % 24 === 0 ? 'k' : x % 24 === 1 ? 'Z' : 'z'; // wall panels with a lit edge
      else if (y === FLOOR_Y - 2) c = '-';
      else if (y === FLOOR_Y - 1) c = 'k';
      else {
        // Floor tiles: seams every 4 rows; vertical seams lean out from the middle, so the floor recedes.
        const d = y - FLOOR_Y;
        const lean = Math.round(((x - w / 2) * (d + 6)) / 24);
        const seam = d % 4 === 3 || ((x - Math.round(w / 2) - lean + 1200) % 12 === 0 && d % 4 !== 3);
        c = seam ? 'z' : 'Z';
      }
      r += c;
    }
    out.push(r);
  }
  return out;
}

const cache = new Map<number, Anim>();

// The room at width w (grid cells); stars twinkle and a wall lamp blinks.
export function roomAnim(w: number): Anim {
  let a = cache.get(w);
  if (a) return a;
  const base = rows(w);
  // The window sits right of the operator's desk, when the panel is wide enough.
  const wx = w >= 96 ? Math.min(w - 26, 58) : -1;
  const win = (i: number): Layer[] =>
    wx < 0
      ? []
      : [
          [WINDOW, wx, 6],
          [STARS[i], wx + 3, 9],
        ];
  const frames = [0, 1].map((i) =>
    frame(w, ROOM_H, [[base, 0, 0], ...win(i), [LAMP[i], wx > 0 ? wx + 8 : w - 12, 1]]),
  );
  a = anim(frames, [16, 16]);
  cache.set(w, a);
  return a;
}
