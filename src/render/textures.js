// Procedurally generated, tileable PBR textures (no external image assets required).
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';

function lattice(period, seed) {
  const rnd = mulberry32(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return g;
}

/** Tileable fractal value noise in [0,1]. */
export function fbm(size, basePeriod, octaves, seed, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const g = lattice(period, seed + o * 101);
    const scale = period / size;
    for (let y = 0; y < size; y++) {
      const fy = y * scale, y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % period) * period, r1 = ((y0 + 1) % period) * period;
      for (let x = 0; x < size; x++) {
        const fx = x * scale, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % period, c1 = (x0 + 1) % period;
        const a = g[r0 + c0] + (g[r0 + c1] - g[r0 + c0]) * sx;
        const b = g[r1 + c0] + (g[r1 + c1] - g[r1 + c0]) * sx;
        out[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= gain;
    period *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function dataTex(data, size, srgb, repeat = true) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function normalFromHeight(h, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      out[i] = ((nx / len) * 0.5 + 0.5) * 255;
      out[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function packColor(size, fn) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const [r, g, b, a = 1] = fn(i);
    out[i * 4] = Math.min(255, Math.max(0, r * 255));
    out[i * 4 + 1] = Math.min(255, Math.max(0, g * 255));
    out[i * 4 + 2] = Math.min(255, Math.max(0, b * 255));
    out[i * 4 + 3] = Math.min(255, Math.max(0, a * 255));
  }
  return out;
}

function drawCracks(h, size, rnd, count, depth) {
  for (let c = 0; c < count; c++) {
    let x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI * 2;
    const len = 40 + rnd() * 160;
    for (let s = 0; s < len; s++) {
      a += (rnd() - 0.5) * 0.6;
      x += Math.cos(a); y += Math.sin(a);
      const ix = ((Math.floor(x) % size) + size) % size, iy = ((Math.floor(y) % size) + size) % size;
      h[iy * size + ix] -= depth;
      if (rnd() < 0.02) { // branch
        drawCracks(h, size, rnd, 0, depth);
      }
    }
  }
}

export function makeAsphalt(size = 1024) {
  const rnd = mulberry32(77);
  const base = fbm(size, 16, 6, 11, 0.55);
  const fine = fbm(size, 128, 3, 23, 0.6);
  const blotch = fbm(size, 4, 4, 31, 0.5);
  const h = new Float32Array(size * size);
  const stones = new Float32Array(size * size);
  for (let i = 0; i < size * size * 0.08; i++) {
    const p = Math.floor(rnd() * size * size);
    stones[p] = rnd() < 0.5 ? 1 : -1;
  }
  for (let i = 0; i < h.length; i++) h[i] = base[i] * 0.35 + fine[i] * 0.5 + stones[i] * 0.25;
  const crackH = new Float32Array(size * size);
  drawCracks(crackH, size, rnd, 14, 1);
  for (let i = 0; i < h.length; i++) h[i] += crackH[i] * 0.6;
  const albedo = packColor(size, (i) => {
    const v = 0.17 + fine[i] * 0.09 + (blotch[i] - 0.5) * 0.07 + stones[i] * 0.05 + crackH[i] * 0.04;
    return [v * 1.02, v, v * 0.98];
  });
  const rough = packColor(size, (i) => {
    const r = 0.82 + fine[i] * 0.12 - (blotch[i] > 0.62 ? 0.12 : 0) + crackH[i] * -0.05;
    return [1, r, 0];
  });
  return {
    map: dataTex(albedo, size, true),
    roughnessMap: dataTex(rough, size, false),
    normalMap: dataTex(normalFromHeight(h, size, 2.2), size, false),
  };
}

export function makeConcretePavers(size = 512, tiles = 4) {
  const n = fbm(size, 16, 5, 41);
  const fine = fbm(size, 128, 2, 43);
  const tileRnd = mulberry32(5);
  const tileShade = [];
  for (let i = 0; i < tiles * tiles; i++) tileShade.push(tileRnd());
  const h = new Float32Array(size * size);
  const joint = new Float32Array(size * size);
  const tsz = size / tiles;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x % tsz) / tsz, fy = (y % tsz) / tsz;
    const j = Math.min(fx, 1 - fx, fy, 1 - fy) < 0.018 ? 1 : 0;
    const i = y * size + x;
    joint[i] = j;
    h[i] = n[i] * 0.4 + fine[i] * 0.4 - j * 1.2;
  }
  const albedo = packColor(size, (i) => {
    const x = i % size, y = Math.floor(i / size);
    const t = tileShade[Math.floor(y / tsz) * tiles + Math.floor(x / tsz)];
    const v = 0.52 + (n[i] - 0.5) * 0.14 + fine[i] * 0.06 + (t - 0.5) * 0.06 - joint[i] * 0.22;
    return [v, v * 0.985, v * 0.96];
  });
  const rough = packColor(size, (i) => [1, 0.88 + fine[i] * 0.1, 0]);
  return { map: dataTex(albedo, size, true), roughnessMap: dataTex(rough, size, false), normalMap: dataTex(normalFromHeight(h, size, 3), size, false) };
}

export function makeConcrete(size = 512) {
  const n = fbm(size, 8, 6, 51);
  const fine = fbm(size, 64, 3, 53);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = n[i] * 0.5 + fine[i] * 0.5;
  const albedo = packColor(size, (i) => { const v = 0.55 + (n[i] - 0.5) * 0.18 + (fine[i] - 0.5) * 0.08; return [v, v * 0.99, v * 0.97]; });
  const rough = packColor(size, (i) => [1, 0.85 + fine[i] * 0.12, 0]);
  return { map: dataTex(albedo, size, true), roughnessMap: dataTex(rough, size, false), normalMap: dataTex(normalFromHeight(h, size, 1.5), size, false), height: n };
}

export function makeGrass(size = 512) {
  const n = fbm(size, 8, 5, 61);
  const blades = fbm(size, 256, 2, 63, 0.7);
  const dry = fbm(size, 4, 3, 67);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = blades[i] * 0.8 + n[i] * 0.2;
  const albedo = packColor(size, (i) => {
    const d = Math.max(0, dry[i] - 0.55) * 1.6;
    const v = 0.55 + blades[i] * 0.5;
    // sRGB lawn values kept low-chroma (blue channel well above zero): neon green is the giveaway of fake grass
    return [(0.2 + d * 0.2) * v, (0.255 + n[i] * 0.06 + d * 0.07) * v, (0.13 + d * 0.05) * v];
  });
  const rough = packColor(size, (i) => [1, 0.9, 0]);
  return { map: dataTex(albedo, size, true), roughnessMap: dataTex(rough, size, false), normalMap: dataTex(normalFromHeight(h, size, 2), size, false) };
}

export function makeBrick(size = 512) {
  const n = fbm(size, 16, 4, 71);
  const fine = fbm(size, 128, 2, 73);
  const rnd = mulberry32(9);
  const rows = 16, cols = 8;
  const shades = [];
  for (let i = 0; i < rows * cols * 2; i++) shades.push(rnd());
  const h = new Float32Array(size * size);
  const mortar = new Float32Array(size * size);
  const bh = size / rows, bw = size / cols;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const row = Math.floor(y / bh);
    const xo = (x + (row % 2) * bw * 0.5) % size;
    const fx = (xo % bw) / bw, fy = (y % bh) / bh;
    const m = fx < 0.04 || fy < 0.1 ? 1 : 0;
    const i = y * size + x;
    mortar[i] = m;
    h[i] = (1 - m) * (0.8 + fine[i] * 0.2) + n[i] * 0.1;
  }
  const albedo = packColor(size, (i) => {
    const x = i % size, y = Math.floor(i / size);
    const row = Math.floor(y / bh);
    const col = Math.floor(((x + (row % 2) * bw * 0.5) % size) / bw);
    const s = shades[row * cols + col];
    if (mortar[i]) { const v = 0.55 + fine[i] * 0.1; return [v, v * 0.97, v * 0.92]; }
    const v = 0.75 + (s - 0.5) * 0.35 + (fine[i] - 0.5) * 0.15;
    return [0.52 * v, 0.25 * v, 0.18 * v];
  });
  const rough = packColor(size, (i) => [1, mortar[i] ? 0.95 : 0.8 + fine[i] * 0.1, 0]);
  return { map: dataTex(albedo, size, true), roughnessMap: dataTex(rough, size, false), normalMap: dataTex(normalFromHeight(h, size, 4), size, false) };
}

export function makeNoiseTex(size, period, octaves, seed) {
  const n = fbm(size, period, octaves, seed);
  return dataTex(packColor(size, (i) => [n[i], n[i], n[i]]), size, false);
}

/** Fine random normal map used for metallic paint flakes. */
export function makeFlakeNormal(size = 256) {
  const rnd = mulberry32(99);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = rnd() * Math.PI * 2, r = Math.pow(rnd(), 2) * 0.35;
    out[i * 4] = (Math.cos(a) * r * 0.5 + 0.5) * 255;
    out[i * 4 + 1] = (Math.sin(a) * r * 0.5 + 0.5) * 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = 255;
  }
  const t = dataTex(out, size, false);
  t.magFilter = THREE.NearestFilter;
  return t;
}

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

export function makeLeafCluster() {
  const rnd = mulberry32(7);
  return canvasTex(512, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 520; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * w * 0.44;
      const x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r;
      const s = 9 + rnd() * 14;
      const l = 22 + rnd() * 22, sat = 35 + rnd() * 25, hue = 80 + rnd() * 40;
      g.fillStyle = `hsl(${hue},${sat}%,${l}%)`;
      g.save(); g.translate(x, y); g.rotate(rnd() * Math.PI);
      g.beginPath(); g.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = `hsla(${hue},${sat}%,${l - 10}%,0.6)`; g.lineWidth = 1;
      g.beginPath(); g.moveTo(-s, 0); g.lineTo(s, 0); g.stroke();
      g.restore();
    }
  });
}

export function makeGrassBlades() {
  const rnd = mulberry32(3);
  return canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w, bend = (rnd() - 0.5) * 40, ht = h * (0.45 + rnd() * 0.55);
      const grad = g.createLinearGradient(0, h, 0, h - ht);
      grad.addColorStop(0, '#1d2f10');
      grad.addColorStop(1, `hsl(${72 + rnd() * 22},${22 + rnd() * 14}%,${28 + rnd() * 14}%)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x - 3, h);
      g.quadraticCurveTo(x + bend * 0.5, h - ht * 0.5, x + bend, h - ht);
      g.quadraticCurveTo(x + bend * 0.5 + 2, h - ht * 0.5, x + 3, h);
      g.fill();
    }
  });
}

export function makeSkidTex() {
  return canvasTex(64, 256, (g, w, h) => {
    const rnd = mulberry32(17);
    g.clearRect(0, 0, w, h);
    for (let x = 0; x < w; x++) {
      const a = 0.35 + rnd() * 0.5;
      const edge = Math.min(x, w - 1 - x) / (w * 0.15);
      g.fillStyle = `rgba(255,255,255,${a * Math.min(1, edge)})`;
      g.fillRect(x, 0, 1, h);
    }
  }, false);
}

const ADS = [
  { bg: ['#0b2a4a', '#1366a6'], title: 'NOVA AIR', sub: 'Fly further for less', accent: '#ffd23f' },
  { bg: ['#3b0d0d', '#b3261e'], title: 'TORQUE COLA', sub: 'Zero sugar. Full throttle.', accent: '#ffffff' },
  { bg: ['#0f2d1f', '#2e8b57'], title: 'GREENLEAF BANK', sub: 'Banking that grows with you', accent: '#d9f99d' },
  { bg: ['#1b1b1f', '#4b4b55'], title: 'VANTA PHONE X', sub: 'Darker. Faster. Smarter.', accent: '#7dd3fc' },
  { bg: ['#4a2b05', '#e08a1e'], title: 'SUNCOAST RESORTS', sub: 'Your weekend starts here', accent: '#fff7ed' },
  { bg: ['#1e1033', '#6d28d9'], title: 'PULSE FM 98.4', sub: 'The sound of the city', accent: '#f0abfc' },
];
export function makeBillboard(i) {
  const ad = ADS[i % ADS.length];
  return canvasTex(1024, 384, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, ad.bg[0]); grad.addColorStop(1, ad.bg[1]);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.globalAlpha = 0.18; g.fillStyle = '#fff';
    g.beginPath(); g.arc(w * 0.85, h * 0.3, h * 0.7, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#fff'; g.font = 'bold 120px Helvetica, Arial, sans-serif'; g.textBaseline = 'middle';
    g.fillText(ad.title, 60, h * 0.42);
    g.fillStyle = ad.accent; g.font = '500 48px Helvetica, Arial, sans-serif';
    g.fillText(ad.sub, 64, h * 0.75);
  });
}

export function makeSignTex(kind, text = []) {
  if (kind === 'stop') {
    return canvasTex(256, 256, (g, w) => {
      g.clearRect(0, 0, w, w);
      g.fillStyle = '#fff';
      octagon(g, w / 2, w / 2, w * 0.49); g.fill();
      g.fillStyle = '#b3121b';
      octagon(g, w / 2, w / 2, w * 0.45); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 74px Helvetica, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('STOP', w / 2, w / 2 + 4);
    });
  }
  if (kind === 'gantry') {
    return canvasTex(1024, 256, (g, w, h) => {
      g.fillStyle = '#0d5c2e'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(10, 10, w - 20, h - 20);
      g.fillStyle = '#fff'; g.font = 'bold 72px Helvetica, Arial'; g.textBaseline = 'middle';
      g.fillText(text[0] || '', 40, h * 0.36);
      g.font = '600 52px Helvetica, Arial';
      g.fillText(text[1] || '', 40, h * 0.74);
      g.beginPath(); g.moveTo(w - 120, h * 0.8); g.lineTo(w - 120, h * 0.3); g.lineTo(w - 150, h * 0.42); g.moveTo(w - 120, h * 0.3); g.lineTo(w - 90, h * 0.42); g.lineWidth = 12; g.stroke();
    });
  }
  // speed limit
  return canvasTex(128, 192, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#111'; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#111'; g.textAlign = 'center';
    g.font = 'bold 26px Helvetica, Arial'; g.fillText('SPEED', w / 2, 46); g.fillText('LIMIT', w / 2, 76);
    g.font = 'bold 76px Helvetica, Arial'; g.fillText(text[0] || '50', w / 2, 160);
  });
}

function octagon(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.closePath();
}

export function makeChainLink() {
  return canvasTex(128, 128, (g, w) => {
    g.clearRect(0, 0, w, w);
    g.strokeStyle = 'rgba(190,195,200,1)'; g.lineWidth = 3;
    for (let i = -w; i < w * 2; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + w, w); g.stroke();
      g.beginPath(); g.moveTo(i + w, 0); g.lineTo(i, w); g.stroke();
    }
  });
}

export function makeTireTex() {
  return canvasTex(512, 64, (g, w, h) => {
    g.fillStyle = '#151516'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#0b0b0c';
    for (let x = 0; x < w; x += 16) { g.fillRect(x, 10, 6, h - 20); }
    g.fillStyle = '#1d1d1f';
    for (let x = 8; x < w; x += 32) { g.fillRect(x, 0, 2, h); }
  });
}

// ---------------------------------------------------------------------------
// Prewar-city texture set
// ---------------------------------------------------------------------------

/** Brick with neutral (luminance-only) colour so each building can tint it red, buff, brown or grey. */
export function makeBrickNeutral(size = 512) {
  const rows = 16, cols = 5;
  const n = fbm(size, 16, 4, 171), fine = fbm(size, 128, 2, 173), stain = fbm(size, 4, 4, 177);
  const rnd = mulberry32(19);
  const shade = [];
  for (let i = 0; i < rows * cols * 2; i++) shade.push(rnd());
  const bh = size / rows, bw = size / cols;
  const h = new Float32Array(size * size), mortar = new Uint8Array(size * size), brickId = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const row = Math.floor(y / bh);
    const xo = (x + (row % 2) * bw * 0.5) % size;
    const fx = (xo % bw) / bw, fy = (y % bh) / bh;
    const i = y * size + x;
    const m = fx < 0.035 || fy < 0.11 ? 1 : 0;
    mortar[i] = m;
    brickId[i] = row * cols + Math.floor(xo / bw);
    // slightly rounded brick edges + surface pitting
    const edge = Math.min(fx, 1 - fx) * 6, edgeY = Math.min(fy - 0.11, 1 - fy) * 4;
    h[i] = m ? 0.15 : 0.75 + Math.min(1, Math.min(edge, edgeY)) * 0.15 + fine[i] * 0.12;
  }
  const albedo = packColor(size, (i) => {
    if (mortar[i]) { const v = 0.78 + fine[i] * 0.1 - stain[i] * 0.12; return [v, v * 0.98, v * 0.94]; }
    const s = shade[brickId[i]];
    const burnt = s > 0.88 ? 0.55 : 1;           // occasional clinker brick
    const v = (0.62 + (s - 0.5) * 0.28 + (fine[i] - 0.5) * 0.14 + (n[i] - 0.5) * 0.1) * burnt - stain[i] * 0.08;
    return [v, v * 0.97, v * 0.93];
  });
  const rough = packColor(size, (i) => [1, mortar[i] ? 0.95 : 0.78 + fine[i] * 0.15, 0]);
  return { map: dataTex(albedo, size, true), roughnessMap: dataTex(rough, size, false), normalMap: dataTex(normalFromHeight(h, size, 5), size, false) };
}

/** Limestone / cast-stone ashlar blocks with fine pitting and soot variation. */
export function makeStone(size = 512) {
  const rows = 5, n = fbm(size, 8, 5, 211), fine = fbm(size, 96, 3, 213), soot = fbm(size, 4, 4, 217);
  const rnd = mulberry32(23);
  const shades = Array.from({ length: 64 }, () => rnd());
  const h = new Float32Array(size * size), joint = new Uint8Array(size * size), id = new Uint8Array(size * size);
  const rh = size / rows;
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / rh), fy = (y % rh) / rh;
    const cols = 3, bw = size / cols;
    for (let x = 0; x < size; x++) {
      const xo = (x + (row % 2) * bw * 0.5) % size, fx = (xo % bw) / bw;
      const i = y * size + x;
      const j = fx < 0.012 || fy < 0.03 ? 1 : 0;
      joint[i] = j;
      id[i] = (row * cols + Math.floor(xo / bw)) % 64;
      h[i] = j ? 0.2 : 0.8 + fine[i] * 0.15 + n[i] * 0.1;
    }
  }
  const albedo = packColor(size, (i) => {
    const s = shades[id[i]];
    const v = 0.74 + (s - 0.5) * 0.08 + (fine[i] - 0.5) * 0.08 + (n[i] - 0.5) * 0.06 - soot[i] * 0.12 - joint[i] * 0.18;
    return [v, v * 0.975, v * 0.93];
  });
  const rough = packColor(size, (i) => [1, 0.86 + fine[i] * 0.1, 0]);
  return { map: dataTex(albedo, size, true), roughnessMap: dataTex(rough, size, false), normalMap: dataTex(normalFromHeight(h, size, 3), size, false) };
}

/** 4x4 atlas of road/sidewalk decals (alpha). Cell order documented in DECAL. */
export const DECAL = { manhole: 0, grate: 1, oil: 2, patch: 3, arrowS: 4, arrowL: 5, arrowR: 6, crack: 7, paper: 8, can: 9, leaves: 10, stain: 11, gum: 12, seam: 13, utility: 14, wet: 15 };
export function makeDecalAtlas() {
  const rnd = mulberry32(31);
  return canvasTex(1024, 1024, (g) => {
    g.clearRect(0, 0, 1024, 1024);
    const cell = (k, fn) => { g.save(); g.translate((k % 4) * 256, Math.floor(k / 4) * 256); g.beginPath(); g.rect(0, 0, 256, 256); g.clip(); fn(g); g.restore(); };
    const blob = (cx, cy, r, color, n = 40) => {
      for (let i = 0; i < n; i++) {
        const a = rnd() * 6.28, d = Math.sqrt(rnd()) * r;
        g.fillStyle = color; g.globalAlpha = 0.08 + rnd() * 0.12;
        g.beginPath(); g.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.7, r * (0.2 + rnd() * 0.4), r * (0.15 + rnd() * 0.3), rnd() * 3, 0, 6.28); g.fill();
      }
      g.globalAlpha = 1;
    };
    cell(DECAL.manhole, (g) => {
      g.fillStyle = '#2b2a28'; g.beginPath(); g.arc(128, 128, 118, 0, 6.28); g.fill();
      g.strokeStyle = '#4a4741'; g.lineWidth = 10; g.stroke();
      g.strokeStyle = '#3c3a36'; g.lineWidth = 6;
      for (let r = 30; r < 110; r += 22) { g.beginPath(); g.arc(128, 128, r, 0, 6.28); g.stroke(); }
      for (let a = 0; a < 12; a++) { g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(a * 0.524) * 110, 128 + Math.sin(a * 0.524) * 110); g.stroke(); }
      g.fillStyle = '#55524b'; g.font = 'bold 22px Helvetica'; g.textAlign = 'center'; g.fillText('SEWER', 128, 136);
    });
    cell(DECAL.grate, (g) => {
      g.fillStyle = '#1e1d1b'; g.fillRect(28, 78, 200, 100);
      g.fillStyle = '#3f3c37'; for (let x = 36; x < 222; x += 14) g.fillRect(x, 84, 6, 88);
      g.strokeStyle = '#4b4842'; g.lineWidth = 8; g.strokeRect(28, 78, 200, 100);
    });
    cell(DECAL.oil, (g) => blob(128, 128, 90, '#0d0c0b', 70));
    cell(DECAL.patch, (g) => {
      g.fillStyle = 'rgba(28,28,30,0.85)'; g.fillRect(14, 30, 228, 196);
      g.strokeStyle = 'rgba(10,10,10,0.9)'; g.lineWidth = 5; g.strokeRect(14, 30, 228, 196);
      for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(${90 + rnd() * 60},${90 + rnd() * 60},${90 + rnd() * 60},0.35)`; g.fillRect(14 + rnd() * 228, 30 + rnd() * 196, 2, 2); }
    });
    const arrow = (g, kind) => {
      g.fillStyle = 'rgba(235,235,228,0.95)';
      g.beginPath();
      g.moveTo(118, 250); g.lineTo(138, 250); g.lineTo(138, 120);
      if (kind === 'S') { g.lineTo(160, 120); g.lineTo(128, 20); g.lineTo(96, 120); g.lineTo(118, 120); }
      else if (kind === 'L') { g.lineTo(138, 110); g.quadraticCurveTo(138, 70, 90, 70); g.lineTo(90, 96); g.lineTo(28, 58); g.lineTo(90, 20); g.lineTo(90, 46); g.quadraticCurveTo(118, 46, 118, 110); }
      else { g.lineTo(118, 110); g.quadraticCurveTo(118, 70, 166, 70); g.lineTo(166, 96); g.lineTo(228, 58); g.lineTo(166, 20); g.lineTo(166, 46); g.quadraticCurveTo(138, 46, 138, 110); }
      g.closePath(); g.fill();
    };
    cell(DECAL.arrowS, (g) => arrow(g, 'S'));
    cell(DECAL.arrowL, (g) => arrow(g, 'L'));
    cell(DECAL.arrowR, (g) => arrow(g, 'R'));
    cell(DECAL.crack, (g) => {
      g.strokeStyle = 'rgba(8,8,8,0.8)'; g.lineCap = 'round';
      for (let c = 0; c < 3; c++) {
        let x = 20 + rnd() * 40, y = 40 + rnd() * 180; g.lineWidth = 2 + rnd() * 3; g.beginPath(); g.moveTo(x, y);
        while (x < 236) { x += 6 + rnd() * 10; y += (rnd() - 0.5) * 18; g.lineTo(x, y); }
        g.stroke();
      }
    });
    cell(DECAL.paper, (g) => { for (let i = 0; i < 6; i++) { g.save(); g.translate(30 + rnd() * 196, 30 + rnd() * 196); g.rotate(rnd() * 6); g.fillStyle = rnd() < 0.5 ? '#e8e4da' : '#d9cfb8'; g.fillRect(-14, -10, 24 + rnd() * 18, 16 + rnd() * 12); g.restore(); } });
    cell(DECAL.can, (g) => { for (let i = 0; i < 5; i++) { g.save(); g.translate(30 + rnd() * 196, 30 + rnd() * 196); g.rotate(rnd() * 6); g.fillStyle = ['#b81d1d', '#c9c9c9', '#2f6b2f', '#d8b21e'][i % 4]; g.fillRect(-16, -7, 32, 14); g.fillStyle = '#888'; g.fillRect(14, -7, 4, 14); g.restore(); } });
    cell(DECAL.leaves, (g) => { for (let i = 0; i < 70; i++) { g.save(); g.translate(rnd() * 256, rnd() * 256); g.rotate(rnd() * 6); g.fillStyle = `hsl(${25 + rnd() * 30},${45 + rnd() * 25}%,${22 + rnd() * 18}%)`; g.beginPath(); g.ellipse(0, 0, 9, 4, 0, 0, 6.28); g.fill(); g.restore(); } });
    cell(DECAL.stain, (g) => blob(128, 128, 100, '#1a1712', 50));
    cell(DECAL.gum, (g) => { for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(20,20,20,${0.25 + rnd() * 0.35})`; g.beginPath(); g.arc(rnd() * 256, rnd() * 256, 3 + rnd() * 4, 0, 6.28); g.fill(); } });
    cell(DECAL.seam, (g) => { g.fillStyle = 'rgba(12,12,12,0.85)'; g.fillRect(0, 120, 256, 16); });
    cell(DECAL.utility, (g) => { g.fillStyle = '#34322e'; g.fillRect(48, 48, 160, 160); g.strokeStyle = '#4c4943'; g.lineWidth = 8; g.strokeRect(48, 48, 160, 160); g.fillStyle = '#4c4943'; g.font = 'bold 26px Helvetica'; g.textAlign = 'center'; g.fillText('WATER', 128, 137); });
    cell(DECAL.wet, (g) => blob(128, 128, 110, '#000000', 30));
  });
}

export const SHOP_NAMES = ['WINE SHOP', 'GROCERY STORE', 'DRESS STORE', 'FASHION OUTLET', 'DELI & BAGELS', 'HARDWARE', 'PHARMACY', 'BOOKS'];
/** Awning valance text, one shop name per row (8 rows). */
export function makeSignAtlas() {
  return canvasTex(1024, 512, (g) => {
    g.clearRect(0, 0, 1024, 512);
    g.fillStyle = '#f4f1e8'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '600 40px Helvetica, Arial';
    SHOP_NAMES.forEach((s, i) => g.fillText(s, 512, i * 64 + 34));
  });
}

/** Airy leaf clusters with gaps, so branches show through the canopy. */
export function makeLeafSparse(seed = 7, hueBase = 85) {
  const rnd = mulberry32(seed);
  return canvasTex(512, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const clusters = 9;
    for (let c = 0; c < clusters; c++) {
      const ca = rnd() * 6.28, cr = Math.sqrt(rnd()) * w * 0.33;
      const cx = w / 2 + Math.cos(ca) * cr, cy = h / 2 + Math.sin(ca) * cr;
      for (let i = 0; i < 55; i++) {
        const a = rnd() * 6.28, r = Math.sqrt(rnd()) * w * 0.12;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        const s = 7 + rnd() * 9;
        // olive, low-chroma greens: real foliage is far less saturated than it looks in memory
        const l = 15 + rnd() * 20, sat = 18 + rnd() * 20, hue = hueBase - 12 + rnd() * 30;
        g.fillStyle = `hsl(${hue},${sat}%,${l}%)`;
        g.save(); g.translate(x, y); g.rotate(rnd() * Math.PI);
        g.beginPath(); g.ellipse(0, 0, s, s * 0.5, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    }
    // twigs
    g.strokeStyle = 'rgba(55,42,30,0.9)'; g.lineWidth = 2;
    for (let i = 0; i < 12; i++) { g.beginPath(); g.moveTo(w / 2, h / 2); g.lineTo(w / 2 + (rnd() - 0.5) * w * 0.7, h / 2 + (rnd() - 0.5) * h * 0.7); g.stroke(); }
  });
}

/** Simple stripe texture (orange/white for barriers, steam pipes, umbrellas). */
export function makeStripes(c1, c2, n = 4, horizontal = true) {
  return canvasTex(128, 128, (g, w, h) => {
    for (let i = 0; i < n * 2; i++) {
      g.fillStyle = i % 2 ? c2 : c1;
      if (horizontal) g.fillRect(0, (i * h) / (n * 2), w, h / (n * 2) + 1);
      else g.fillRect((i * w) / (n * 2), 0, w / (n * 2) + 1, h);
    }
  });
}
