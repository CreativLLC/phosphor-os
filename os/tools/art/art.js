// Original wallpaper art for the Phosphor-OS OS themes, drawn on a canvas.
// wallpapers.mjs opens art.html in headless Edge and calls window.render(job) for each image.
// Everything is seeded, so a design looks the same at every size.
'use strict';

const TAU = Math.PI * 2;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(h, a) {
  const [r, g, b] = hexRgb(h);
  return `rgba(${r},${g},${b},${a})`;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function makeNoise(rand) {
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    vals[i] = rand();
    perm[i] = i;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i];
  const at = (x, y) => vals[perm[(perm[x & 255] + (y & 255)) & 511]];
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = sm(x - xi);
    const v = sm(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fbm(n, x, y, oct = 4) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * n(x * f, y * f);
    norm += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

// ---------------------------------------------------------------- phosphor helpers

function phPal(theme) {
  const c = theme.colors;
  return { ph: c.foreground, bright: c.bright_foreground, dim: c.dark_foreground, bg: c.background, hot: theme.tone.hot, deep: c.dark_background };
}

function glowOn(ctx, color, blur) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
}
function glowOff(ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

function backdrop(ctx, w, h, P, cx, cy, r) {
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, P.hot);
  g.addColorStop(0.55, rgba(P.hot, 0.45));
  g.addColorStop(1, rgba(P.bg, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function starfield(ctx, rand, P, u, x0, y0, x1, y1, count, fade) {
  for (let i = 0; i < count; i++) {
    const x = x0 + rand() * (x1 - x0);
    const y = y0 + rand() * (y1 - y0);
    let a = Math.pow(rand(), 1.7) * 0.85 + 0.1;
    if (fade) a *= fade(x, y);
    if (a < 0.03) continue;
    const big = rand() < 0.08;
    const s = Math.max(1, Math.round((big ? 2 : 1) * u));
    ctx.fillStyle = rgba(P.bright, a);
    ctx.fillRect(Math.round(x), Math.round(y), s, s);
    if (rand() < 0.018) {
      // A few bright stars get a soft halo and a faint cross.
      const r = 7 * u;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(P.bright, 0.55 * a + 0.2));
      g.addColorStop(1, rgba(P.bright, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.fillStyle = rgba(P.bright, 0.35);
      ctx.fillRect(Math.round(x - 9 * u), Math.round(y), Math.round(18 * u), Math.max(1, Math.round(u * 0.8)));
      ctx.fillRect(Math.round(x), Math.round(y - 9 * u), Math.max(1, Math.round(u * 0.8)), Math.round(18 * u));
    }
  }
}

function vt(ctx, px) {
  ctx.font = `${Math.round(px)}px VT323`;
  ctx.textBaseline = 'alphabetic';
}

// Corner-bracket box with a few readout lines (numbers and plain abbreviations, nothing brand-like).
function readout(ctx, P, u, x, y, lines, opts = {}) {
  const fs = 25 * u;
  const lh = fs * 1.05;
  vt(ctx, fs);
  let wmax = 0;
  for (const l of lines) wmax = Math.max(wmax, ctx.measureText(l).width);
  const pad = 14 * u;
  const bw = wmax + pad * 2;
  const bh = lines.length * lh + pad * 1.6;
  const k = 14 * u;
  ctx.save();
  // Dark backing so lines behind the box do not run through the text.
  ctx.fillStyle = rgba(P.bg, 0.88);
  ctx.fillRect(x, y, bw, bh);
  ctx.globalAlpha = opts.alpha ?? 0.75;
  ctx.strokeStyle = P.ph;
  ctx.lineWidth = Math.max(1, 1.4 * u);
  glowOn(ctx, rgba(P.ph, 0.7), 6 * u);
  ctx.beginPath();
  ctx.moveTo(x, y + k);
  ctx.lineTo(x, y);
  ctx.lineTo(x + k, y);
  ctx.moveTo(x + bw - k, y);
  ctx.lineTo(x + bw, y);
  ctx.lineTo(x + bw, y + k);
  ctx.moveTo(x + bw, y + bh - k);
  ctx.lineTo(x + bw, y + bh);
  ctx.lineTo(x + bw - k, y + bh);
  ctx.moveTo(x + k, y + bh);
  ctx.lineTo(x, y + bh);
  ctx.lineTo(x, y + bh - k);
  ctx.stroke();
  ctx.fillStyle = P.ph;
  lines.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? P.bright : P.ph;
    ctx.fillText(l, x + pad, y + pad * 0.8 + lh * (i + 0.8));
  });
  ctx.restore();
  return { w: bw, h: bh };
}

function crt(ctx, w, h, u, opts = {}) {
  // Scanlines: one dark row per period, snapped to whole pixels so they stay crisp.
  const p = Math.max(2, Math.floor(3 * u));
  const lw = Math.max(1, Math.floor(p / 2));
  ctx.fillStyle = `rgba(0,0,0,${opts.scan ?? 0.24})`;
  for (let y = 0; y < h; y += p) ctx.fillRect(0, y + p - lw, w, lw);
  // Vignette.
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.56);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${opts.vignette ?? 0.62})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// ---------------------------------------------------------------- phosphor design 1: vector terrain

function designTerrain(ctx, w, h, theme, seed) {
  const P = phPal(theme);
  const u = h / 1440;
  const rand = mulberry32(seed);
  const noise = makeNoise(mulberry32(seed + 7));
  const hy = h * 0.58;
  const cx = w / 2;
  backdrop(ctx, w, h, P, cx, hy, Math.max(w, h) * 0.62);

  // Sky.
  starfield(ctx, rand, P, u, 0, 0, w, hy, Math.round((w * hy) / 3000), (x, y) => smooth(hy * 1.02, hy * 0.55, y) * 0.9 + 0.1);

  // A thin ringed moon low in the sky, off center.
  {
    const mx = w * 0.5 + h * 0.46;
    const my = hy - h * 0.2;
    const mr = h * 0.055;
    ctx.save();
    ctx.lineWidth = 1.1 * u;
    ctx.strokeStyle = rgba(P.ph, 0.4);
    ctx.beginPath();
    ctx.ellipse(mx, my, mr * 2.1, mr * 0.34, -0.22, Math.PI, TAU);
    ctx.stroke();
    ctx.fillStyle = P.bg;
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, TAU);
    ctx.fill();
    glowOn(ctx, rgba(P.ph, 0.8), 10 * u);
    ctx.strokeStyle = rgba(P.ph, 0.85);
    ctx.lineWidth = 1.6 * u;
    ctx.stroke();
    ctx.lineWidth = 1.1 * u;
    ctx.strokeStyle = rgba(P.ph, 0.4);
    for (let k = -2; k <= 2; k++) {
      const yy = my + (k * mr) / 3;
      const rx = Math.sqrt(Math.max(0, mr * mr - (yy - my) ** 2));
      ctx.beginPath();
      ctx.ellipse(mx, yy, rx, rx * 0.12, 0, 0, Math.PI);
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(P.ph, 0.7);
    ctx.lineWidth = 1.4 * u;
    ctx.beginPath();
    ctx.ellipse(mx, my, mr * 2.1, mr * 0.34, -0.22, 0, Math.PI);
    ctx.stroke();
    ctx.restore();
  }

  // Terrain: a world-space grid of square cells, rows drawn far to near. Each row fills the ground below
  // itself, which hides what lies behind it (painter's hidden lines).
  const f = h * 0.9;
  const camH = 1;
  const G = 0.42;
  const zNear = 1.9;
  const zFar = 46;
  const rows = [];
  for (let z = zFar; z >= zNear - 1e-9; z -= G) rows.push(z);
  const groundFill = ctx.createLinearGradient(0, hy, 0, h);
  groundFill.addColorStop(0, P.hot);
  groundFill.addColorStop(0.35, P.bg);
  groundFill.addColorStop(1, P.bg);
  const height = (X, z) => {
    const sx = Math.abs((X * f) / z) / (w / 2);
    const valley = smooth(0.16, 1.0, sx);
    const far = smooth(16, 40, z);
    const n = fbm(noise, X * 0.28 + 40, z * 0.28, 5);
    const ridge = 1 - Math.abs(2 * n - 1);
    const amp = 2.6 * Math.pow(valley, 1.4) * smooth(1.9, 9, z) + far * (1.2 + 3.4 * fbm(noise, X * 0.05 + 9, 3, 3));
    return Math.max(0, amp * (ridge - 0.35) * 1.5) + 0.04 * Math.sin(X * 0.9 + z);
  };
  const sy = (X, z) => hy + (f * (camH - height(X, z))) / z;
  const sxOf = (X, z) => cx + (f * X) / z;
  let prev = null;
  ctx.lineJoin = 'round';
  rows.forEach((z, i) => {
    const near = 1 - (z - zNear) / (zFar - zNear);
    const half = ((w / 2) * z) / f * 1.08;
    const step = ((5 * u) * z) / f;
    const pts = [];
    for (let X = -half; X <= half + step; X += step) pts.push([sxOf(X, z), sy(X, z)]);
    const alpha = 0.1 + 0.9 * Math.pow(near, 1.35);
    // Grid lines running toward the horizon, between this row and the one behind it.
    if (prev !== null) {
      ctx.strokeStyle = rgba(P.ph, alpha * 0.75);
      ctx.lineWidth = Math.max(0.8, (0.7 + 0.9 * near) * u);
      glowOn(ctx, rgba(P.ph, 0.5), 5 * u * near);
      ctx.beginPath();
      const m0 = Math.ceil(-half / G);
      const m1 = Math.floor(half / G);
      for (let m = m0; m <= m1; m++) {
        const X = m * G;
        ctx.moveTo(sxOf(X, prev), sy(X, prev));
        ctx.lineTo(sxOf(X, z), sy(X, z));
      }
      ctx.stroke();
    }
    glowOff(ctx);
    ctx.fillStyle = groundFill;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h + 10);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(pts[pts.length - 1][0], h + 10);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rgba(i === 0 ? P.bright : P.ph, i === 0 ? 0.55 : alpha);
    ctx.lineWidth = Math.max(0.8, (0.8 + 1.1 * near) * u);
    glowOn(ctx, rgba(P.ph, 0.65), (2 + 7 * near) * u);
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    prev = z;
  });
  glowOff(ctx);

  readout(ctx, P, u, 70 * u, h - 250 * u, ['NAV 04-117', 'HDG 271.40   ALT 02210', 'VEL 0.381    TRK 7', 'GRID 22.6 / 08.1'], { alpha: 0.7 });
  crt(ctx, w, h, u);
}

// ---------------------------------------------------------------- phosphor design 2: scope

function designScope(ctx, w, h, theme, seed) {
  const P = phPal(theme);
  const u = h / 1440;
  const rand = mulberry32(seed);
  const noise = makeNoise(mulberry32(seed + 3));
  const cx = w / 2;
  const cy = h * 0.49;
  const R = h * 0.34;
  backdrop(ctx, w, h, P, cx, cy, h * 0.75);

  // Graph-paper grid.
  const minor = 40 * u;
  ctx.lineWidth = Math.max(1, u);
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = rgba(P.ph, pass ? 0.1 : 0.045);
    ctx.beginPath();
    const stepX = pass ? minor * 5 : minor;
    for (let x = (cx % stepX) - stepX; x < w; x += stepX) {
      const xx = Math.round(x) + 0.5;
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, h);
    }
    for (let y = (cy % stepX) - stepX; y < h; y += stepX) {
      const yy = Math.round(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
    }
    ctx.stroke();
  }

  // Scope face.
  ctx.save();
  ctx.fillStyle = rgba(P.bg, 0.86);
  ctx.beginPath();
  ctx.arc(cx, cy, R + 4 * u, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Sweep.
  const a = -0.62;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.clip();
  // Conic stops run over the full turn, so the 1.2 rad wedge is the first 1.2/TAU of it.
  const span = 1.2 / TAU;
  const cg = ctx.createConicGradient(a - 1.2, cx, cy);
  cg.addColorStop(0, rgba(P.ph, 0));
  cg.addColorStop(span * 0.6, rgba(P.ph, 0.05));
  cg.addColorStop(span * 0.995, rgba(P.ph, 0.32));
  cg.addColorStop(span, rgba(P.ph, 0));
  cg.addColorStop(1, rgba(P.ph, 0));
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, a - 1.2, a);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.save();
  glowOn(ctx, rgba(P.ph, 0.8), 8 * u);
  for (let k = 1; k <= 4; k++) {
    ctx.strokeStyle = rgba(P.ph, k === 4 ? 0.9 : 0.32);
    ctx.lineWidth = (k === 4 ? 2 : 1.1) * u;
    ctx.beginPath();
    ctx.arc(cx, cy, (R * k) / 4, 0, TAU);
    ctx.stroke();
  }
  ctx.strokeStyle = rgba(P.ph, 0.5);
  ctx.lineWidth = 1.2 * u;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 16 * u, 0, TAU);
  ctx.stroke();
  glowOff(ctx);
  // Spokes.
  ctx.strokeStyle = rgba(P.ph, 0.13);
  ctx.lineWidth = u;
  ctx.setLineDash([4 * u, 7 * u]);
  ctx.beginPath();
  for (let d = 0; d < 360; d += 30) {
    const t = (d * Math.PI) / 180;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // Bearing ticks and labels around the rim.
  ctx.strokeStyle = rgba(P.ph, 0.6);
  ctx.beginPath();
  for (let d = 0; d < 360; d += 2) {
    const len = d % 30 === 0 ? 24 * u : d % 10 === 0 ? 14 * u : 7 * u;
    const t = ((d - 90) * Math.PI) / 180;
    const r0 = R + 16 * u;
    ctx.moveTo(cx + Math.cos(t) * r0, cy + Math.sin(t) * r0);
    ctx.lineTo(cx + Math.cos(t) * (r0 + len), cy + Math.sin(t) * (r0 + len));
  }
  ctx.stroke();
  vt(ctx, 24 * u);
  ctx.textAlign = 'center';
  ctx.fillStyle = rgba(P.ph, 0.75);
  for (let d = 0; d < 360; d += 30) {
    const t = ((d - 90) * Math.PI) / 180;
    const rr = R + 62 * u;
    ctx.fillText(String(d).padStart(3, '0'), cx + Math.cos(t) * rr, cy + Math.sin(t) * rr + 8 * u);
  }
  ctx.textAlign = 'left';
  // Sweep edge.
  glowOn(ctx, rgba(P.bright, 0.9), 12 * u);
  ctx.strokeStyle = rgba(P.bright, 0.9);
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  ctx.stroke();
  // Contacts: brighter just behind the sweep, fading around the dial.
  vt(ctx, 21 * u);
  const placed = [];
  for (let i = 0; i < 8; i++) {
    let ang;
    let rr;
    let x;
    let y;
    // Keep contacts apart so their labels never overlap.
    for (let tries = 0; tries < 40; tries++) {
      ang = rand() * TAU;
      rr = R * (0.22 + 0.7 * rand());
      x = cx + Math.cos(ang) * rr;
      y = cy + Math.sin(ang) * rr;
      if (placed.every(([px, py]) => Math.hypot(px - x, py - y) > 120 * u)) break;
    }
    placed.push([x, y]);
    let behind = (a - ang) % TAU;
    if (behind < 0) behind += TAU;
    const b = 0.25 + 0.75 * Math.exp(-behind / 1.6);
    const s = 7 * u;
    const head = rand() * TAU;
    for (let k = 3; k >= 1; k--) {
      ctx.fillStyle = rgba(P.ph, b * (0.5 - k * 0.12));
      ctx.fillRect(x - Math.cos(head) * k * 14 * u - 2 * u, y - Math.sin(head) * k * 14 * u - 2 * u, 4 * u, 4 * u);
    }
    glowOn(ctx, rgba(P.bright, 0.9), 10 * u * b);
    ctx.fillStyle = rgba(P.bright, b);
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
    ctx.strokeStyle = rgba(P.ph, b * 0.7);
    ctx.lineWidth = u;
    ctx.strokeRect(x - s * 1.6, y - s * 1.6, s * 3.2, s * 3.2);
    glowOff(ctx);
    ctx.fillStyle = rgba(P.ph, b * 0.85);
    ctx.fillText(`C-${String(11 + Math.floor(rand() * 80))}`, x + s * 2.2, y - s * 1.2);
  }
  // Center mark.
  ctx.strokeStyle = rgba(P.bright, 0.8);
  ctx.lineWidth = 1.4 * u;
  ctx.beginPath();
  ctx.moveTo(cx - 16 * u, cy);
  ctx.lineTo(cx + 16 * u, cy);
  ctx.moveTo(cx, cy - 16 * u);
  ctx.lineTo(cx, cy + 16 * u);
  ctx.stroke();
  ctx.restore();

  // Left: channel meters.
  {
    const x0 = Math.max(70 * u, w * 0.06);
    let y = h * 0.3;
    vt(ctx, 23 * u);
    for (let i = 0; i < 9; i++) {
      const lvl = 4 + Math.floor(fbm(noise, i * 0.7, 2.3) * 22);
      ctx.fillStyle = rgba(P.ph, 0.6);
      ctx.fillText(`CH${i + 1}`, x0, y + 15 * u);
      for (let s = 0; s < 22; s++) {
        const on = s < lvl;
        ctx.fillStyle = on ? rgba(s > 18 ? P.bright : P.ph, s > 18 ? 0.9 : 0.62) : rgba(P.ph, 0.1);
        ctx.fillRect(x0 + 52 * u + s * 12 * u, y, 8 * u, 18 * u);
      }
      ctx.fillStyle = rgba(P.ph, 0.45);
      ctx.fillText(String(lvl * 37 + 100).padStart(4, '0'), x0 + 52 * u + 22 * 12 * u + 12 * u, y + 15 * u);
      y += 34 * u;
    }
  }
  // Right: spectrum.
  {
    const bw = 340 * u;
    const x0 = w - Math.max(70 * u, w * 0.06) - bw;
    const y0 = h * 0.62;
    const bh = 150 * u;
    ctx.strokeStyle = rgba(P.ph, 0.4);
    ctx.lineWidth = u;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0 - bh) + 0.5, Math.round(bw), Math.round(bh));
    const n = 34;
    for (let i = 0; i < n; i++) {
      const v = Math.pow(fbm(noise, i * 0.33, 7.1, 3), 1.6) * 1.25;
      const hh = clamp(v, 0.04, 1) * (bh - 12 * u);
      ctx.fillStyle = rgba(P.ph, 0.25 + 0.55 * v);
      ctx.fillRect(x0 + 6 * u + i * ((bw - 12 * u) / n), y0 - 6 * u - hh, ((bw - 12 * u) / n) * 0.62, hh);
    }
    vt(ctx, 23 * u);
    ctx.fillStyle = rgba(P.ph, 0.6);
    ctx.fillText('BAND 0.2 - 4.8', x0, y0 + 30 * u);
    ctx.fillText('GAIN +12', x0 + bw - 100 * u, y0 + 30 * u);
  }
  // Bottom trace.
  {
    const y0 = h * 0.955;
    glowOn(ctx, rgba(P.ph, 0.7), 6 * u);
    ctx.strokeStyle = rgba(P.ph, 0.45);
    ctx.lineWidth = 1.3 * u;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 3 * u) {
      const t = x / (90 * u);
      const env = 0.35 + 0.65 * Math.pow(Math.sin((x / w) * Math.PI), 2);
      const y = y0 + (Math.sin(t) * 14 + (fbm(noise, x / (40 * u), 1.7, 3) - 0.5) * 30) * u * env;
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    glowOff(ctx);
  }
  crt(ctx, w, h, u);
}

// ---------------------------------------------------------------- phosphor design 3: orbit

function sphereLines(ctx, P, u, cx, cy, R, rotX, rotZ, light, step) {
  const rot = (x, y, z) => {
    let y1 = y * Math.cos(rotX) - z * Math.sin(rotX);
    let z1 = y * Math.sin(rotX) + z * Math.cos(rotX);
    const x2 = x * Math.cos(rotZ) - y1 * Math.sin(rotZ);
    const y2 = x * Math.sin(rotZ) + y1 * Math.cos(rotZ);
    return [x2, y2, z1];
  };
  const seg = (pts) => {
    // pts in sphere coords; draws only the parts facing the viewer, dimmer on the night side.
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      if (p[2] < 0 || q[2] < 0) continue;
      const lit = clamp((p[0] * light[0] + p[1] * light[1] + p[2] * light[2]) * 0.9 + 0.25, 0.08, 1);
      ctx.strokeStyle = rgba(P.ph, 0.5 * lit);
      ctx.beginPath();
      ctx.moveTo(cx + p[0] * R, cy + p[1] * R);
      ctx.lineTo(cx + q[0] * R, cy + q[1] * R);
      ctx.stroke();
    }
  };
  for (let lat = -75; lat <= 75; lat += step) {
    const pts = [];
    const phi = (lat * Math.PI) / 180;
    for (let lon = 0; lon <= 360; lon += 2) {
      const th = (lon * Math.PI) / 180;
      pts.push(rot(Math.cos(phi) * Math.cos(th), Math.sin(phi), Math.cos(phi) * Math.sin(th)));
    }
    seg(pts);
  }
  for (let lon = 0; lon < 180; lon += step) {
    const pts = [];
    const th = (lon * Math.PI) / 180;
    for (let lat = 0; lat <= 360; lat += 2) {
      const phi = (lat * Math.PI) / 180;
      pts.push(rot(Math.cos(phi) * Math.cos(th), Math.sin(phi), Math.cos(phi) * Math.sin(th)));
    }
    seg(pts);
  }
}

function designOrbit(ctx, w, h, theme, seed) {
  const P = phPal(theme);
  const u = h / 1440;
  const rand = mulberry32(seed);
  const pcx = w * 0.5 + h * 0.6;
  const pcy = h * 1.12;
  const PR = h * 0.7;
  backdrop(ctx, w, h, P, pcx, pcy - PR, h * 1.1);
  starfield(ctx, rand, P, u, 0, 0, w, h, Math.round((w * h) / 2600), (x, y) => (Math.hypot(x - pcx, y - pcy) < PR + 40 * u ? 0 : 1));

  // Distant moon.
  {
    const mx = w * 0.5 - h * 0.62;
    const my = h * 0.24;
    const mr = h * 0.05;
    ctx.save();
    ctx.lineWidth = Math.max(1, 1.1 * u);
    glowOn(ctx, rgba(P.ph, 0.7), 6 * u);
    ctx.strokeStyle = rgba(P.ph, 0.7);
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, TAU);
    ctx.stroke();
    glowOff(ctx);
    sphereLines(ctx, P, u, mx, my, mr, 0.4, 0.3, [0.6, -0.5, 0.62], 30);
    ctx.restore();
  }

  // Planet: atmosphere halo, solid face that hides the stars, wire grid, bright limb.
  ctx.save();
  const halo = ctx.createRadialGradient(pcx, pcy, PR * 0.98, pcx, pcy, PR + 60 * u);
  halo.addColorStop(0, rgba(P.ph, 0.22));
  halo.addColorStop(1, rgba(P.ph, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(pcx - PR - 70 * u, pcy - PR - 70 * u, (PR + 70 * u) * 2, (PR + 70 * u) * 2);
  const face = ctx.createRadialGradient(pcx + PR * 0.35, pcy - PR * 0.55, PR * 0.1, pcx, pcy, PR);
  face.addColorStop(0, P.hot);
  face.addColorStop(1, P.bg);
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(pcx, pcy, PR, 0, TAU);
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.1 * u);
  sphereLines(ctx, P, u, pcx, pcy, PR, 0.42, -0.18, [0.55, -0.6, 0.58], 12);
  glowOn(ctx, rgba(P.ph, 0.9), 14 * u);
  ctx.strokeStyle = rgba(P.bright, 0.85);
  ctx.lineWidth = 2.2 * u;
  ctx.beginPath();
  ctx.arc(pcx, pcy, PR, 0, TAU);
  ctx.stroke();
  glowOff(ctx);
  ctx.restore();

  // Orbit: a tilted ring; the part behind the planet is hidden, the far half is dimmer and dashed.
  {
    // Seen from just below the ring plane, so the near half crosses the planet's face.
    const OR = PR * 1.34;
    const tilt = 1.22;
    const rz = 0.3;
    let marker = null;
    for (let i = 0; i < 720; i++) {
      const t0 = (i / 720) * TAU;
      const t1 = ((i + 1) / 720) * TAU;
      const pt = (t) => {
        const x = Math.cos(t) * OR;
        const y0 = Math.sin(t) * OR;
        const y = -y0 * Math.cos(tilt);
        const z = y0 * Math.sin(tilt);
        return [pcx + x * Math.cos(rz) - y * Math.sin(rz), pcy + x * Math.sin(rz) + y * Math.cos(rz), z];
      };
      const p = pt(t0);
      const q = pt(t1);
      const behind = p[2] < 0;
      if (behind && Math.hypot(p[0] - pcx, p[1] - pcy) < PR) continue;
      if (behind && i % 4 > 1) continue;
      ctx.strokeStyle = rgba(P.ph, behind ? 0.35 : 0.75);
      ctx.lineWidth = (behind ? 1 : 1.6) * u;
      if (!behind) glowOn(ctx, rgba(P.ph, 0.6), 6 * u);
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(q[0], q[1]);
      ctx.stroke();
      glowOff(ctx);
      if (!behind && q[0] > 0 && q[1] > 0 && q[1] < h * 0.9 && (!marker || Math.abs(q[0] - (pcx - PR * 1.12)) < Math.abs(marker[0] - (pcx - PR * 1.12)))) marker = q;
    }
    if (marker && marker[0] > 0 && marker[0] < w && marker[1] > 0 && marker[1] < h) {
      const [mx, my] = marker;
      ctx.save();
      glowOn(ctx, rgba(P.bright, 0.9), 10 * u);
      ctx.fillStyle = P.bright;
      ctx.beginPath();
      ctx.moveTo(mx, my - 9 * u);
      ctx.lineTo(mx + 8 * u, my + 6 * u);
      ctx.lineTo(mx - 8 * u, my + 6 * u);
      ctx.closePath();
      ctx.fill();
      glowOff(ctx);
      ctx.strokeStyle = rgba(P.ph, 0.75);
      ctx.lineWidth = 1.2 * u;
      ctx.strokeRect(mx - 20 * u, my - 20 * u, 40 * u, 40 * u);
      ctx.beginPath();
      ctx.moveTo(mx + 20 * u, my - 20 * u);
      ctx.lineTo(mx + 70 * u, my - 70 * u);
      ctx.lineTo(mx + 190 * u, my - 70 * u);
      ctx.stroke();
      vt(ctx, 24 * u);
      ctx.fillStyle = rgba(P.bright, 0.9);
      ctx.fillText('OBJ 02   PER 94.6', mx + 76 * u, my - 78 * u);
      ctx.restore();
    }
  }

  readout(ctx, P, u, 70 * u, h * 0.62, ['ORBIT 2 OF 9', 'APO 4120   PERI 3880', 'INC 41.2   T- 00:46:12'], { alpha: 0.7 });
  crt(ctx, w, h, u);
}

// ---------------------------------------------------------------- LCARS helpers

function lcFont(ctx, px, weight = 600) {
  // Setting font resets fontStretch, so the stretch goes in the shorthand and is set again after.
  ctx.font = `${weight} condensed ${Math.round(px)}px Antonio, Bahnschrift, 'Roboto Condensed', 'Arial Narrow', sans-serif`;
  ctx.fontStretch = 'condensed';
}

function pill(ctx, x, y, w, h, color, ends = 'both') {
  const r = h / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ends === 'both') ctx.roundRect(x, y, w, h, r);
  else if (ends === 'right') ctx.roundRect(x, y, w, h, [0, r, r, 0]);
  else if (ends === 'left') ctx.roundRect(x, y, w, h, [r, 0, 0, r]);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

// Elbow: a vertical column joined to a horizontal bar with a big outer curve and a small inner one.
// corner: 'tl' (bar on top) or 'bl' (bar at the bottom).
function elbow(ctx, x, y0, y1, colW, barEnd, barH, ro, ri, color, corner) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (corner === 'tl') {
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y0 + ro);
    ctx.arcTo(x, y0, x + ro, y0, ro);
    ctx.lineTo(barEnd, y0);
    ctx.lineTo(barEnd, y0 + barH);
    ctx.lineTo(x + colW + ri, y0 + barH);
    ctx.arcTo(x + colW, y0 + barH, x + colW, y0 + barH + ri, ri);
    ctx.lineTo(x + colW, y1);
  } else {
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1 - ro);
    ctx.arcTo(x, y1, x + ro, y1, ro);
    ctx.lineTo(barEnd, y1);
    ctx.lineTo(barEnd, y1 - barH);
    ctx.lineTo(x + colW + ri, y1 - barH);
    ctx.arcTo(x + colW, y1 - barH, x + colW, y1 - barH - ri, ri);
    ctx.lineTo(x + colW, y0);
  }
  ctx.closePath();
  ctx.fill();
}

function code(rand, parts = 2) {
  const a = String(Math.floor(rand() * 90) + 10);
  const b = String(Math.floor(rand() * 9000) + 1000);
  return parts === 1 ? b : `${a}-${b}`;
}

function blockLabel(ctx, u, text, x, y, w, h) {
  lcFont(ctx, 26 * u);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'right';
  ctx.fillText(text, x + w - 12 * u, y + h - 10 * u);
  ctx.textAlign = 'left';
}

// A bar split into colored segments with black gaps, ending in a rounded cap.
function segBar(ctx, u, rand, x0, x1, y, hgt, colors, cap) {
  const gap = 10 * u;
  const capW = 110 * u;
  const span = x1 - x0 - capW - gap;
  const weights = colors.map(() => 0.4 + rand());
  const sum = weights.reduce((s, v) => s + v, 0);
  let x = x0;
  colors.forEach((c, i) => {
    const sw = (weights[i] / sum) * (span - gap * (colors.length - 1));
    ctx.fillStyle = c;
    ctx.fillRect(x, y, sw, hgt);
    x += sw + gap;
  });
  pill(ctx, x, y, x1 - x, hgt, cap, 'right');
}

// ---------------------------------------------------------------- LCARS design 1: console

function designConsole(ctx, w, h, theme, seed) {
  const L = theme.lcars;
  const u = h / 1440;
  const rand = mulberry32(seed);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const m = 64 * u;
  const yt = 96 * u;
  const yb = h - 64 * u;
  const cw = 250 * u;
  const th = 58 * u;
  const bh = 34 * u;
  const g = 10 * u;
  const reach = m + cw + 300 * u;

  // Top elbow and bar.
  const topColEnd = yt + 330 * u;
  elbow(ctx, m, yt, topColEnd, cw, reach, th, 160 * u, 60 * u, L.orange, 'tl');
  blockLabel(ctx, u, code(rand), m, topColEnd - 70 * u, cw, 70 * u);
  segBar(ctx, u, rand, reach + g, w - m, yt, th, [L.lilac, L.gold, L.periwinkle, L.peach], L.orange);

  // Bottom elbow and bar.
  const botColStart = yb - 300 * u;
  elbow(ctx, m, botColStart, yb, cw, reach, bh, 130 * u, 40 * u, L.lilac, 'bl');
  blockLabel(ctx, u, code(rand), m, botColStart, cw, 70 * u);
  segBar(ctx, u, rand, reach + g, w - m, yb - bh, bh, [L.lavender, L.orange, L.peach, L.periwinkle, L.lilac], L.gold);

  // Column blocks between the elbows.
  {
    const y0 = topColEnd + g;
    const y1 = botColStart - g;
    const parts = [0.9, 1.6, 0.6, 2.2, 1.0, 0.7];
    const cols = [L.peach, L.periwinkle, L.red, L.lavender, L.gold, L.orange];
    const total = parts.reduce((s, v) => s + v, 0);
    const avail = y1 - y0 - g * (parts.length - 1);
    let y = y0;
    parts.forEach((p, i) => {
      const bhh = (p / total) * avail;
      ctx.fillStyle = cols[i];
      ctx.fillRect(m, y, cw, bhh);
      if (bhh > 44 * u) blockLabel(ctx, u, code(rand), m, y, cw, bhh);
      y += bhh + g;
    });
  }

  // Data columns in the top right.
  {
    const cols = 6;
    const rows = 7;
    const colW = 118 * u;
    const x0 = w - m - cols * colW;
    const y0 = yt + th + 70 * u;
    lcFont(ctx, 28 * u, 500);
    ctx.textAlign = 'right';
    const palette = [L.orange, L.peach, L.lavender, L.periwinkle, L.gold, L.peach];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const n = rand();
        const digits = c === 0 ? 2 : c % 2 ? 5 : 3;
        const val = String(Math.floor(n * 10 ** digits)).padStart(digits, '0');
        ctx.fillStyle = r === 3 && c > 2 ? L.orange : palette[(r + c * 2) % palette.length];
        ctx.fillText(val, x0 + (c + 1) * colW - 10 * u, y0 + r * 40 * u);
      }
    }
    ctx.textAlign = 'left';
    // A highlight bar behind one row, like a selected line.
    ctx.fillStyle = L.orange;
    ctx.fillRect(x0 - 26 * u, y0 + 3 * 40 * u - 26 * u, 14 * u, 32 * u);
  }

  // Button stack on the right.
  {
    const bw = 200 * u;
    const bhh = 50 * u;
    const x = w - m - bw;
    let y = h * 0.5;
    const cols = [L.lavender, L.periwinkle, L.gold, L.lilac];
    cols.forEach((c) => {
      pill(ctx, x, y, bw, bhh, c, 'both');
      lcFont(ctx, 24 * u);
      ctx.fillStyle = '#000';
      ctx.textAlign = 'right';
      ctx.fillText(code(rand, 1), x + bw - 28 * u, y + bhh - 14 * u);
      ctx.textAlign = 'left';
      y += bhh + g;
    });
  }

  // Thin status line along the inside of the bottom bar.
  {
    const y = yb - bh - 40 * u;
    const x0 = m + cw + 60 * u;
    lcFont(ctx, 26 * u, 500);
    ctx.fillStyle = L.peach;
    ctx.fillText(`${code(rand)}   ${code(rand)}   ${code(rand, 1)}`, x0, y);
  }
}

// ---------------------------------------------------------------- LCARS design 2: split screen

function designSplit(ctx, w, h, theme, seed) {
  const L = theme.lcars;
  const u = h / 1440;
  const rand = mulberry32(seed);
  const noise = makeNoise(mulberry32(seed + 5));
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const m = 64 * u;
  const yt = 96 * u;
  const yb = h - 64 * u;
  const yd = h * 0.33;
  const cw = 230 * u;
  const g = 10 * u;
  const th = 30 * u;
  const reach = m + cw + 240 * u;

  // Upper section: column blocks, then an elbow turning right along the divider.
  const upElbowTop = yd - 190 * u;
  {
    const y0 = yt;
    const y1 = upElbowTop - g;
    const parts = [1.2, 0.8];
    const cols = [L.lavender, L.peach];
    const total = parts.reduce((s, v) => s + v, 0);
    let y = y0;
    parts.forEach((p, i) => {
      const hh = (p / total) * (y1 - y0 - g);
      ctx.fillStyle = cols[i];
      ctx.beginPath();
      if (i === 0) ctx.roundRect(m, y, cw, hh, [60 * u, 0, 0, 0]);
      else ctx.rect(m, y, cw, hh);
      ctx.fill();
      blockLabel(ctx, u, code(rand), m, y, cw, hh);
      y += hh + g;
    });
  }
  elbow(ctx, m, upElbowTop, yd, cw, reach, th, 110 * u, 36 * u, L.orange, 'bl');
  blockLabel(ctx, u, code(rand), m, upElbowTop, cw, 70 * u);
  segBar(ctx, u, rand, reach + g, w - m, yd - th, th, [L.lilac, L.periwinkle, L.gold, L.lavender], L.peach);

  // Upper header: a big code and a short row of pills.
  {
    lcFont(ctx, 120 * u, 500);
    ctx.textAlign = 'right';
    ctx.fillStyle = L.orange;
    ctx.fillText(code(rand), w - m, yt + 100 * u);
    ctx.textAlign = 'left';
    const pw = 150 * u;
    const ph = 44 * u;
    let x = m + cw + 60 * u;
    const y = yt + 10 * u;
    [L.periwinkle, L.lilac, L.gold].forEach((c) => {
      pill(ctx, x, y, pw, ph, c, 'both');
      lcFont(ctx, 24 * u);
      ctx.fillStyle = '#000';
      ctx.textAlign = 'right';
      ctx.fillText(code(rand, 1), x + pw - 24 * u, y + ph - 12 * u);
      ctx.textAlign = 'left';
      x += pw + g * 2;
    });
    lcFont(ctx, 28 * u, 500);
    ctx.fillStyle = L.peach;
    ctx.fillText(`${code(rand)}  ${code(rand)}  ${code(rand)}  ${code(rand)}`, m + cw + 60 * u, yt + 120 * u);
    ctx.fillStyle = L.lavender;
    ctx.fillText(`${code(rand)}  ${code(rand)}  ${code(rand)}`, m + cw + 60 * u, yt + 160 * u);
  }

  // Lower section: an elbow under the divider, then column blocks down to a rounded foot.
  const ld = yd + 22 * u;
  const lowElbowEnd = ld + 200 * u;
  elbow(ctx, m, ld, lowElbowEnd, cw, reach, th, 110 * u, 36 * u, L.periwinkle, 'tl');
  blockLabel(ctx, u, code(rand), m, lowElbowEnd - 70 * u, cw, 70 * u);
  segBar(ctx, u, rand, reach + g, w - m, ld, th, [L.gold, L.lavender, L.orange, L.lilac], L.lavender);
  {
    const y0 = lowElbowEnd + g;
    const parts = [1.4, 0.5, 2.0, 0.9, 1.2];
    const cols = [L.peach, L.red, L.lilac, L.gold, L.orange];
    const total = parts.reduce((s, v) => s + v, 0);
    const avail = yb - y0 - g * (parts.length - 1);
    let y = y0;
    parts.forEach((p, i) => {
      const hh = (p / total) * avail;
      ctx.fillStyle = cols[i];
      ctx.beginPath();
      if (i === parts.length - 1) ctx.roundRect(m, y, cw, hh, [0, 0, 0, 60 * u]);
      else ctx.rect(m, y, cw, hh);
      ctx.fill();
      if (hh > 44 * u) blockLabel(ctx, u, code(rand), m, y, cw, hh);
      y += hh + g;
    });
  }

  // Lower right: bar readout, rows of rounded bars of different lengths.
  {
    const x0 = Math.max(w * 0.56, w - m - 900 * u);
    const x1 = w - m - 20 * u;
    let y = ld + 120 * u;
    const rowH = 24 * u;
    const gap = 18 * u;
    const rows = Math.floor((yb - 100 * u - y) / (rowH + gap));
    lcFont(ctx, 24 * u, 500);
    for (let i = 0; i < rows; i++) {
      const v = 0.22 + 0.78 * Math.pow(fbm(noise, i * 0.9, 3.3, 2) * 0.4 + rand() * 0.6, 1.3);
      const c = i === 4 ? L.orange : i % 3 === 0 ? L.lilac : i % 2 ? L.periwinkle : L.lavender;
      ctx.fillStyle = L.peach;
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.floor(v * 1000)).padStart(3, '0'), x0 + 70 * u, y + rowH - 3 * u);
      ctx.textAlign = 'left';
      pill(ctx, x0 + 90 * u, y, (x1 - x0 - 90 * u) * v, rowH, c, 'right');
      y += rowH + gap;
    }
  }

  // Lower middle: a sensor ring schematic.
  {
    const rcx = m + cw + (Math.max(w * 0.56, w - m - 900 * u) - (m + cw)) * 0.5;
    const rcy = ld + (yb - ld) * 0.52;
    const R = Math.min(h * 0.21, (Math.max(w * 0.56, w - m - 900 * u) - (m + cw)) * 0.33);
    ctx.lineWidth = 3 * u;
    for (let k = 1; k <= 3; k++) {
      ctx.strokeStyle = k === 3 ? L.lavender : L.periwinkle;
      ctx.beginPath();
      ctx.arc(rcx, rcy, (R * k) / 3, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = L.lavender;
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.moveTo(rcx - R * 1.15, rcy);
    ctx.lineTo(rcx + R * 1.15, rcy);
    ctx.moveTo(rcx, rcy - R * 1.15);
    ctx.lineTo(rcx, rcy + R * 1.15);
    ctx.stroke();
    // Arc segments outside the rings, like a dial.
    ctx.lineWidth = 16 * u;
    ctx.lineCap = 'butt';
    [[-0.9, -0.2, L.orange], [0.1, 0.9, L.lilac], [2.2, 3.1, L.gold], [3.6, 4.2, L.periwinkle]].forEach(([a0, a1, c]) => {
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.arc(rcx, rcy, R * 1.12 + 10 * u, a0, a1);
      ctx.stroke();
    });
    for (let i = 0; i < 5; i++) {
      const a = rand() * TAU;
      const r = R * (0.2 + 0.75 * rand());
      ctx.fillStyle = i === 0 ? L.red : L.orange;
      ctx.beginPath();
      ctx.arc(rcx + Math.cos(a) * r, rcy + Math.sin(a) * r, (i === 0 ? 10 : 7) * u, 0, TAU);
      ctx.fill();
    }
    lcFont(ctx, 26 * u, 500);
    ctx.fillStyle = L.peach;
    ctx.textAlign = 'center';
    ctx.fillText(code(rand), rcx, rcy + R * 1.12 + 70 * u);
    ctx.textAlign = 'left';
  }
}

// ---------------------------------------------------------------- previews and boot logo

function mockUI(ctx, w, h, theme) {
  const c = theme.colors;
  const isL = theme.kind === 'lcars';
  const L = theme.lcars || {};
  const u = h / 1012;
  const barH = 26 * u;
  ctx.fillStyle = c.background;
  ctx.fillRect(0, 0, w, barH);
  const fontPx = 15 * u;
  const setFont = () => (isL ? lcFont(ctx, fontPx + 2 * u, 600) : vt(ctx, fontPx + 4 * u));
  setFont();
  const text = isL ? L.orange : c.foreground;
  ctx.fillStyle = text;
  ['1', '2', '3', '4', '5'].forEach((n, i) => {
    const x = 14 * u + i * 24 * u;
    if (i === 0) {
      ctx.fillStyle = isL ? L.orange : c.foreground;
      ctx.fillRect(x - 6 * u, 4 * u, 20 * u, barH - 8 * u);
      ctx.fillStyle = c.background;
    } else ctx.fillStyle = text;
    ctx.fillText(n, x, barH - 8 * u);
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = text;
  ctx.fillText(isL ? 'FRIDAY 12:46' : 'FRI 12:46', w / 2, barH - 8 * u);
  ctx.textAlign = 'right';
  ctx.fillText(isL ? 'NET  VOL  PWR' : 'NET VOL PWR', w - 14 * u, barH - 8 * u);
  ctx.textAlign = 'left';

  const gap = (isL ? 12 : 8) * u;
  const bw = (isL ? 3 : 2) * u;
  const rad = isL ? 18 * u : 0;
  const win = (x, y, ww, hh, active) => {
    ctx.save();
    if (active && !isL) {
      ctx.shadowColor = rgba(c.foreground, 0.5);
      ctx.shadowBlur = 16 * u;
    }
    ctx.fillStyle = c.background;
    ctx.beginPath();
    ctx.roundRect(x, y, ww, hh, rad);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = bw;
    const ib = theme.colors.hyprland_inactive_border.match(/[0-9a-f]{6}/i)[0];
    ctx.strokeStyle = active ? (isL ? L.orange : c.foreground) : rgba('#' + ib, isL ? 0.6 : 0.5);
    ctx.beginPath();
    ctx.roundRect(x + bw / 2, y + bw / 2, ww - bw, hh - bw, rad);
    ctx.stroke();
  };
  // Two windows in the middle, so the wallpaper still shows around them.
  const x0 = w * 0.17;
  const top = h * 0.17;
  const bottom = h * 0.85;
  const leftW = w * 0.56;
  win(x0, top, leftW - x0 - gap / 2, bottom - top, true);
  win(leftW + gap / 2, top, w * 0.83 - leftW - gap / 2, (bottom - top) * 0.5, false);

  // Terminal text.
  const lines = [
    ['$ ', 'ls'],
    ['', 'notes   photos   projects'],
    ['$ ', 'claude'],
    ['', 'Ready. Type a message.'],
    ['> ', 'match the desktop to the app'],
    ['', 'Working ...'],
    ['', 'Done.'],
    ['$ ', ''],
  ];
  isL ? lcFont(ctx, 20 * u, 500) : vt(ctx, 24 * u);
  lines.forEach(([p, t], i) => {
    const y = top + 50 * u + i * 30 * u;
    ctx.fillStyle = isL ? L.orange : c.bright_foreground;
    ctx.fillText(p, x0 + 24 * u, y);
    const pw = ctx.measureText(p).width;
    ctx.fillStyle = p ? (isL ? L.peach : c.foreground) : isL ? L.lavender : c.dark_foreground;
    ctx.fillText(isL ? t.toUpperCase() : t, x0 + 24 * u + pw, y);
    if (i === lines.length - 1) {
      ctx.fillStyle = c.bright_foreground;
      ctx.fillRect(x0 + 24 * u + pw, y - 18 * u, 10 * u, 20 * u);
    }
  });

  // A small meter window.
  const mx = leftW + gap * 0.5 + 20 * u;
  let my = top + 40 * u;
  const mw = w * 0.83 - leftW - gap / 2 - 40 * u;
  isL ? lcFont(ctx, 18 * u, 600) : vt(ctx, 22 * u);
  ['CPU', 'MEM', 'NET', 'DSK'].forEach((lab, i) => {
    const v = [0.62, 0.41, 0.18, 0.77][i];
    ctx.fillStyle = isL ? [L.orange, L.lilac, L.periwinkle, L.gold][i] : c.foreground;
    ctx.fillText(lab, mx, my + 16 * u);
    const bx = mx + 60 * u;
    const bww = mw - 70 * u;
    if (isL) {
      pill(ctx, bx, my, bww * v, 20 * u, [L.orange, L.lilac, L.periwinkle, L.gold][i], 'right');
    } else {
      const segs = 30;
      for (let s = 0; s < segs; s++) {
        ctx.fillStyle = s / segs < v ? c.foreground : rgba(c.foreground, 0.12);
        ctx.fillRect(bx + s * (bww / segs), my, (bww / segs) * 0.7, 20 * u);
      }
    }
    my += 40 * u;
  });
  if (!isL) crt(ctx, w, h, u, { vignette: 0.35, scan: 0.18 });
}

function unlockLogo(ctx, w, h, theme) {
  const c = theme.colors;
  ctx.clearRect(0, 0, w, h);
  if (theme.kind === 'lcars') {
    const L = theme.lcars;
    const u = h / 188;
    // An elbow cap, three blocks and a name, all on a transparent ground.
    elbow(ctx, 0, 6 * u, h - 6 * u, 70 * u, 190 * u, 34 * u, 50 * u, 18 * u, L.orange, 'tl');
    pill(ctx, 200 * u, 6 * u, 150 * u, 34 * u, L.lilac, 'none');
    pill(ctx, 360 * u, 6 * u, 230 * u, 34 * u, L.periwinkle, 'none');
    pill(ctx, 600 * u, 6 * u, w - 600 * u, 34 * u, L.peach, 'right');
    lcFont(ctx, 96 * u, 600);
    ctx.fillStyle = L.orange;
    ctx.fillText('PHOSPHOR-OS', 96 * u, h - 22 * u);
    return;
  }
  const u = h / 188;
  vt(ctx, 150 * u);
  ctx.fillStyle = c.foreground;
  ctx.shadowColor = rgba(c.foreground, 0.7);
  ctx.shadowBlur = 14 * u;
  const t = 'PHOSPHOR-OS';
  const tw = ctx.measureText(t).width;
  const x = (w - tw - 60 * u) / 2;
  ctx.fillText(t, x, h * 0.74);
  ctx.fillRect(x + tw + 18 * u, h * 0.74 - 96 * u, 44 * u, 96 * u);
  ctx.shadowBlur = 0;
}

function unlockPreview(ctx, w, h, theme, logo) {
  const c = theme.colors;
  const isL = theme.kind === 'lcars';
  ctx.fillStyle = c.background;
  ctx.fillRect(0, 0, w, h);
  const lw = 800;
  const lh = 188;
  ctx.drawImage(logo, (w - lw) / 2, h * 0.41, lw, lh);
  const bx = (w - 290) / 2 + 22;
  const by = h * 0.41 + lh + 40;
  ctx.strokeStyle = isL ? theme.lcars.orange : c.foreground;
  ctx.lineWidth = 2;
  ctx.fillStyle = c.lighter_background;
  ctx.beginPath();
  ctx.roundRect(bx, by, 290, 46, isL ? 23 : 0);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = c.bright_foreground;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(bx + 26 + i * 16, by + 23, 4, 0, TAU);
    ctx.fill();
  }
  // Padlock.
  const lx = bx - 48;
  const ly = by + 8;
  ctx.fillStyle = c.bright_foreground;
  ctx.fillRect(lx, ly + 14, 32, 24);
  ctx.strokeStyle = c.bright_foreground;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(lx + 16, ly + 14, 10, Math.PI, 0);
  ctx.stroke();
  if (!isL) crt(ctx, w, h, h / 1440, { vignette: 0.3, scan: 0.2 });
}

// ---------------------------------------------------------------- entry

const DESIGNS = { terrain: designTerrain, scope: designScope, orbit: designOrbit, console: designConsole, split: designSplit };

window.render = async function (job) {
  await document.fonts.load('40px VT323');
  const { theme, kind, w, h, design, seed, format, quality } = job;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (kind === 'wallpaper') DESIGNS[design](ctx, w, h, theme, seed);
  else if (kind === 'preview') {
    DESIGNS[design](ctx, w, h, theme, seed);
    mockUI(ctx, w, h, theme);
  } else if (kind === 'unlock') unlockLogo(ctx, w, h, theme);
  else if (kind === 'unlock-preview') {
    const lc = document.createElement('canvas');
    lc.width = 800;
    lc.height = 188;
    unlockLogo(lc.getContext('2d'), 800, 188, theme);
    unlockPreview(ctx, w, h, theme, lc);
  }
  const url = cv.toDataURL(format === 'png' ? 'image/png' : 'image/jpeg', quality ?? 0.9);
  return url.slice(url.indexOf(',') + 1);
};
window.ready = true;
