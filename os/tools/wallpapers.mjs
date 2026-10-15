// Renders the theme images with headless Edge (nothing shows on screen):
//   os/wallpapers/<theme>/<n>-<design>-<W>x<H>.<jpg|png>      every design at 3440x1440, 2560x1440, 3840x2160
//   os/omarchy/themes/<theme>/backgrounds/<n>-<design>.<ext>  the 3440x1440 copy (pixel exact on 1440p screens)
//   os/omarchy/themes/<theme>/preview.png, unlock.png, preview-unlock.png
// Needs playwright-core: set PLAYWRIGHT_CORE to its index.mjs, or have it installed where Node finds it.
// Options: --theme <id>  --design <name>  --size <WxH>  --out <dir> (flat output for quick looks, no theme files)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { themes } from './palettes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OS = join(HERE, '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core');

// Design list per theme. Seeds differ between amber and green so the two sets are not copies.
const PLAN = {
  'retro-amber': [
    ['terrain', 11],
    ['scope', 21],
    ['orbit', 31],
  ],
  'retro-green': [
    ['terrain', 12],
    ['scope', 22],
    ['orbit', 32],
  ],
  lcars: [
    ['console', 41],
    ['split', 51],
  ],
};
const SIZES = [
  [3440, 1440],
  [2560, 1440],
  [3840, 2160],
];

function save(path, b64) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(b64, 'base64'));
  console.log(path.replace(OS, 'os'), Math.round(Buffer.byteLength(b64, 'base64') / 1024) + ' KB');
}

const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto(pathToFileURL(join(HERE, 'art', 'art.html')).href);
  await page.waitForFunction(() => window.ready === true);
  const render = async (job) => {
    const b64 = await page.evaluate((j) => window.render(j), job);
    if (errors.length) throw errors[0];
    return b64;
  };

  for (const [id, designs] of Object.entries(PLAN)) {
    if (args.theme && args.theme !== id) continue;
    const theme = themes[id];
    const png = theme.kind === 'lcars'; // flat color blocks compress far better as PNG
    const ext = png ? 'png' : 'jpg';
    const fmt = { format: png ? 'png' : 'jpeg', quality: 0.9 };
    let n = 0;
    for (const [design, seed] of designs) {
      n++;
      if (args.design && args.design !== design) continue;
      for (const [w, h] of SIZES) {
        if (args.size && args.size !== `${w}x${h}`) continue;
        const b64 = await render({ theme, kind: 'wallpaper', design, seed, w, h, ...fmt });
        if (args.out) {
          save(join(args.out, `${id}-${design}-${w}x${h}.${ext}`), b64);
          continue;
        }
        save(join(OS, 'wallpapers', id, `${n}-${design}-${w}x${h}.${ext}`), b64);
        if (w === 3440) save(join(OS, 'omarchy', 'themes', id, 'backgrounds', `${n}-${design}.${ext}`), b64);
      }
    }
    if (args.design || args.size) continue;
    const dir = args.out ? args.out : join(OS, 'omarchy', 'themes', id);
    const pre = args.out ? `${id}-` : '';
    const [d0, s0] = designs[0];
    save(join(dir, `${pre}preview.png`), await render({ theme, kind: 'preview', design: d0, seed: s0, w: 1800, h: 1012, format: 'png' }));
    save(join(dir, `${pre}unlock.png`), await render({ theme, kind: 'unlock', w: 800, h: 188, format: 'png' }));
    save(join(dir, `${pre}preview-unlock.png`), await render({ theme, kind: 'unlock-preview', w: 1920, h: 1080, format: 'png' }));
  }
} finally {
  await browser.close();
}
