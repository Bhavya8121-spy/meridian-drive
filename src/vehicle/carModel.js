// Procedural vehicle bodies built by lofting super-elliptic cross-sections along the car.
// Local frame matches the physics: +Z forward, +Y up, +X left, origin on the ground.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, smoothstep, lerp } from '../core/rng.js';
import { createNavDisplay } from './nav-display.js';

export const BODY_TYPES = {
  sport: {
    L: 4.54, W: 1.96, r: 0.345, wf: 1.33, wr: -1.29, archR: 0.405, clearance: 0.16,
    noseY: 0.6, hoodY: 0.84, deckY: 0.97, tailY: 0.9, belt: 0.93, roofY: 1.28,
    cabinZ0: -1.15, cabinZ1: 0.62, roofZ0: -0.62, roofZ1: 0.02, tumble: 0.3, haunch: 0.05, n: 6.0,
  },
  sedan: {
    L: 4.78, W: 1.84, r: 0.33, wf: 1.42, wr: -1.4, archR: 0.39, clearance: 0.18,
    noseY: 0.72, hoodY: 0.95, deckY: 1.02, tailY: 0.98, belt: 1.0, roofY: 1.46,
    cabinZ0: -1.38, cabinZ1: 0.78, roofZ0: -0.82, roofZ1: 0.18, tumble: 0.25, haunch: 0.0, n: 3.6,
  },
  hatch: {
    L: 4.12, W: 1.78, r: 0.32, wf: 1.28, wr: -1.27, archR: 0.38, clearance: 0.17,
    noseY: 0.72, hoodY: 0.95, deckY: 1.08, tailY: 1.06, belt: 1.02, roofY: 1.5,
    cabinZ0: -1.95, cabinZ1: 0.6, roofZ0: -1.75, roofZ1: 0.0, tumble: 0.22, haunch: 0.0, n: 3.4,
  },
  suv: {
    L: 4.72, W: 1.94, r: 0.37, wf: 1.42, wr: -1.38, archR: 0.43, clearance: 0.27,
    noseY: 0.92, hoodY: 1.12, deckY: 1.22, tailY: 1.2, belt: 1.2, roofY: 1.76,
    cabinZ0: -2.22, cabinZ1: 0.85, roofZ0: -2.05, roofZ1: 0.2, tumble: 0.16, haunch: 0.0, n: 5.0,
  },
  van: {
    L: 5.05, W: 1.98, r: 0.35, wf: 1.62, wr: -1.55, archR: 0.41, clearance: 0.22,
    noseY: 0.95, hoodY: 1.18, deckY: 1.4, tailY: 1.4, belt: 1.25, roofY: 2.12,
    cabinZ0: -2.48, cabinZ1: 1.35, roofZ0: -2.45, roofZ1: 0.95, tumble: 0.1, haunch: 0.0, n: 6.0,
  },
};

function pw(points, z) {
  // smooth piecewise interpolation through [z, y] points (sorted by z)
  if (z <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (z <= points[i][0]) {
      const [z0, y0] = points[i - 1], [z1, y1] = points[i];
      const t = (z - z0) / (z1 - z0);
      return y0 + (y1 - y0) * (t * t * (3 - 2 * t));
    }
  }
  return points[points.length - 1][1];
}

function profiles(P) {
  const hl = P.L / 2;
  const top = [
    [-hl, P.tailY - 0.065], [-hl + 0.17, P.tailY], [P.cabinZ0 - 0.25, P.deckY], [P.cabinZ0, P.belt],
    [P.cabinZ1, P.belt - 0.02], [P.cabinZ1 + 0.3, P.hoodY], [hl - 0.24, P.noseY + 0.03], [hl, P.noseY - 0.07],
  ].filter((p, i, a) => i === 0 || p[0] > a[i - 1][0]);
  const bottom = [[-hl, P.clearance + 0.16], [-hl + 0.25, P.clearance], [hl - 0.3, P.clearance], [hl, P.clearance + 0.08]];
  const roof = [[P.cabinZ0, P.belt], [P.roofZ0, P.roofY], [P.roofZ1, P.roofY + 0.01], [P.cabinZ1, P.belt - 0.02]];
  const hw = (z) => {
    const e = Math.abs(z);
    let w = P.W / 2;
    const endT = smoothstep(hl - 0.62, hl + 0.02, e);
    w *= 1 - 0.24 * Math.pow(endT, 1.6);
    if (P.haunch) w += P.haunch * Math.exp(-((z - P.wr) ** 2) / 0.25) + P.haunch * 0.5 * Math.exp(-((z - P.wf) ** 2) / 0.2);
    return w;
  };
  const yTop = (z) => pw(top, z);
  const yBot = (z) => {
    let y = pw(bottom, z);
    for (const az of [P.wf, P.wr]) {
      const d = z - az;
      if (Math.abs(d) < P.archR) {
        const arch = P.r + Math.sqrt(P.archR * P.archR - d * d);
        y = Math.max(y, lerp(y, arch, 1 - smoothstep(P.archR - 0.045, P.archR, Math.abs(d))));
      }
    }
    return Math.min(y, yTop(z) - 0.05);
  };
  const yRoof = (z) => pw(roof, z);
  return { yTop, yBot, yRoof, hw };
}

/** Loft a closed (or partially open) tube through cross-sections. */
function loft(stations, section, segs, opts = {}) {
  const pos = [], uv = [], idx = [];
  const ns = stations.length;
  for (let i = 0; i < ns; i++) {
    const z = stations[i];
    const s = section(z);
    const yc = (s.yb + s.yt) / 2, hh = Math.max(0.002, (s.yt - s.yb) / 2);
    for (let j = 0; j < segs; j++) {
      const phi = (j / segs) * Math.PI * 2;
      const c = Math.cos(phi), sn = Math.sin(phi);
      const ex = Math.sign(c) * Math.pow(Math.abs(c), 2 / s.n);
      const ey = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / s.n);
      const ws = 1 - s.tumble * Math.max(0, ey);
      pos.push(ex * s.hw * ws * (s.inflate || 1), yc + ey * hh * (s.inflate || 1), z);
      uv.push(z * 0.6, j / segs);
    }
  }
  for (let i = 0; i < ns - 1; i++) {
    for (let j = 0; j < segs; j++) {
      if (opts.skip && opts.skip(stations[i], stations[i + 1], j, segs)) continue;
      const a = i * segs + j, b = i * segs + ((j + 1) % segs), c = (i + 1) * segs + j, d = (i + 1) * segs + ((j + 1) % segs);
      idx.push(a, b, c, b, d, c);
    }
  }
  if (opts.caps) {
    for (const [i, front] of [[0, false], [ns - 1, true]]) {
      const base = pos.length / 3;
      let cy = 0;
      for (let j = 0; j < segs; j++) cy += pos[(i * segs + j) * 3 + 1];
      cy /= segs;
      pos.push(0, cy, stations[i]); uv.push(0.5, 0.5);
      for (let j = 0; j < segs; j++) {
        const k = (i * segs + j) * 3;
        pos.push(pos[k], pos[k + 1], pos[k + 2]);
        uv.push(0.5 + pos[k] * 0.4, 0.5 + (pos[k + 1] - cy) * 0.4);
      }
      for (let j = 0; j < segs; j++) {
        const a = base + 1 + j, b = base + 1 + ((j + 1) % segs);
        if (front) idx.push(base, a, b); else idx.push(base, b, a);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function stationsFor(z0, z1, step) {
  const out = [];
  const n = Math.max(2, Math.ceil((z1 - z0) / step));
  for (let i = 0; i <= n; i++) out.push(z0 + ((z1 - z0) * i) / n);
  return out;
}

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function cyl(r, len, x, y, z, axis = 'z', seg = 12) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** Beam between two points (used for pillars, mirror arms). */
function beam(a, b, w, h) {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.BoxGeometry(w, h, d.length());
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), d, new THREE.Vector3(0, 1, 0));
  g.applyMatrix4(m);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Body shell. Each station along the car has a half cross-section of key points (x >= 0), mirrored:
//   K0 bottom centre, K1 underbody edge, K2 rocker, K3 rocker crease, K4 widest side, K5 shoulder,
//   K6 beltline (window sill / hood edge), K7 window top or hood edge, K8 roof rail / hood, K9 top centre
// Paint, side glass, windscreen/backlight and roof are assigned per segment and station, so glass meets
// paint exactly (no gaps), and lights/shut lines are cut from the same surface.
// ---------------------------------------------------------------------------------------------
const K = { bottom: 0, tub: 1, rocker: 2, crease: 3, side: 4, shoulder: 5, belt: 6, upperA: 7, upperB: 8, top: 9 };

function shellFunctions(P) {
  const { yTop, yBot, yRoof, hw } = profiles(P);
  const hl = P.L / 2;
  const roofStart = P.roofZ0, roofEnd = P.roofZ1;
  const archY = (z) => {
    let y = -1;
    for (const az of [P.wf, P.wr]) {
      const d = Math.abs(z - az);
      const R = P.archR + 0.03;
      if (d < R) y = Math.max(y, P.r + Math.sqrt(R * R - d * d) * (1 - 0.35 * smoothstep(R - 0.06, R, d)));
    }
    return y;
  };
  const flare = (z) => 0.022 * (Math.exp(-((z - P.wf) ** 2) / 0.16) + Math.exp(-((z - P.wr) ** 2) / 0.2)) + (P.haunch || 0) * Math.exp(-((z - P.wr) ** 2) / 0.3);
  // how much of a cabin is above this station (0 on the hood/deck, 1 under the roof)
  const cabin = (z) => (z <= P.cabinZ0 || z >= P.cabinZ1 ? 0 : clamp((yRoof(z) - yTop(z)) / Math.max(0.05, P.roofY - P.belt), 0, 1));
  const section = (z) => {
    const w = hw(z) + flare(z) * smoothstep(hl - 0.1, hl - 0.5, Math.abs(z));
    const yb = yBot(z) > P.clearance + 0.05 && archY(z) < 0 ? yBot(z) : P.clearance + (Math.abs(z) > hl - 0.3 ? (Math.abs(z) - (hl - 0.3)) * 0.26 : 0);
    const shoulderY = yTop(z);
    const a = archY(z);
    const rockerY = Math.max(yb + 0.02, a > 0 ? a : yb + 0.05);
    const sideY = Math.max(lerp(yb + 0.1, shoulderY, 0.42), a > 0 ? a + 0.06 : 0);
    const c = cabin(z);
    const tumble = 0.2 + (P.tumble || 0) * 0.35;
    const wR = w * (1 - tumble);
    const upperCentre = Math.max(shoulderY + 0.02, yRoof(z));
    const winTop = lerp(shoulderY + 0.012, shoulderY + (upperCentre - shoulderY) * 0.86, c);
    const pts = [
      [0, yb],
      [w * 0.56, yb],
      [w * 0.9, rockerY],
      [w * 0.975, rockerY + 0.06],
      [w, Math.max(sideY, rockerY + 0.1)],
      [w * 0.988, Math.max(shoulderY - 0.075, rockerY + 0.14)],
      [w * 0.95, shoulderY],
      [lerp(w * 0.8, wR + 0.045, c), winTop],
      [lerp(w * 0.42, wR - 0.075, c), lerp(shoulderY + 0.022, upperCentre - 0.022, c)],
      [0, lerp(shoulderY + 0.03, upperCentre, c)],
    ];
    return { pts, c, w };
  };
  return { section, cabin, yTop, yRoof, hw, roofStart, roofEnd, hl, archY };
}

/** Catmull-Rom subdivided full ring (right half then mirrored left) with the key index of each point. */
function ringFromKeys(half, sub) {
  const keys = [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
  const n = keys.length, out = [], keyOf = [];
  for (let i = 0; i < n; i++) {
    const p0 = keys[(i - 1 + n) % n], p1 = keys[i], p2 = keys[(i + 1) % n], p3 = keys[(i + 2) % n];
    const ki = i < half.length ? i : half.length - 1 - (i - half.length + 1);
    for (let s = 0; s <= sub; s++) {
      const t = s / (sub + 1);
      if (s === 0) { out.push([p1[0], p1[1]]); keyOf.push(ki); continue; }
      // crisp beltline: segments touching the belt stay straight
      const straight = ki === K.belt || keys[(i + 1) % n] === keys[K.belt] || (i >= half.length && ki === K.upperA);
      const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      out.push(straight ? [lerp(p1[0], p2[0], t), lerp(p1[1], p2[1], t)] : [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
      keyOf.push(ki);
    }
  }
  return { ring: out, keyOf };
}

function buildShell(P, lod) {
  const S = shellFunctions(P);
  const hi = lod === 0;
  const sub = hi ? 2 : lod === 1 ? 1 : 0;
  const stations = stationsFor(-S.hl, S.hl, hi ? 0.03 : lod === 1 ? 0.075 : 0.14);
  const rings = stations.map((z) => { const sec = S.section(z); return { z, c: sec.c, ...ringFromKeys(sec.pts, sub) }; });
  const m = rings[0].ring.length;
  const out = { paint: { pos: [], idx: [] }, glass: { pos: [], idx: [] } };
  const quadSlot = (zMid, cMid, k) => {
    // k is the key index at the start of the segment, measured on the right half (mirror uses the same keys)
    if (k === K.belt) return cMid > 0.25 && zMid > P.cabinZ0 + 0.05 && zMid < P.cabinZ1 - 0.04 ? 'glass' : 'paint';
    if (k === K.upperB) return cMid > 0.25 && !(zMid > S.roofStart + 0.03 && zMid < S.roofEnd - 0.03) ? 'glass' : 'paint';
    return 'paint';
  };
  const push = (slot, verts) => {
    const b = out[slot], base = b.pos.length / 3;
    for (const v of verts) b.pos.push(...v);
    b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    const zMid = (A.z + B.z) / 2, cMid = (A.c + B.c) / 2;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      // key of the segment in right-half terms: on the mirrored half the ring runs downwards, so the segment
      // leaving key K (or one of its subdivision points) is the right-half segment that starts at K-1
      const k = j < m / 2 ? A.keyOf[j] : A.keyOf[j] - 1;
      const slot = quadSlot(zMid, cMid, k);
      push(slot, [[A.ring[j][0], A.ring[j][1], A.z], [A.ring[j2][0], A.ring[j2][1], A.z], [B.ring[j][0], B.ring[j][1], B.z], [B.ring[j2][0], B.ring[j2][1], B.z]]);
    }
  }
  // end caps (fascias)
  for (const [R, front] of [[rings[0], false], [rings[rings.length - 1], true]]) {
    const b = out.paint, base = b.pos.length / 3;
    let cy = 0; for (const p of R.ring) cy += p[1]; cy /= m;
    b.pos.push(0, cy, R.z);
    for (const p of R.ring) b.pos.push(p[0], p[1], R.z);
    for (let j = 0; j < m; j++) { const a = base + 1 + j, c = base + 1 + ((j + 1) % m); if (front) b.idx.push(base, a, c); else b.idx.push(base, c, a); }
  }
  const toGeo = ({ pos, idx }) => {
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g = mergeVertices(g, 1e-4);
    g.computeVertexNormals();
    const p = g.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getZ(i) * 2; uv[i * 2 + 1] = p.getY(i) * 2 + p.getX(i); }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  };

  /** A strip lying on the body surface between two keys, over a z-range, lifted along the surface normal. */
  const surfaceStrip = (z0, z1, kFrom, kTo, side, lift = 0.004, xMin = -Infinity) => {
    const zs = stationsFor(z0, z1, hi ? 0.02 : 0.06);
    const pos = [], idx = [];
    const rows = zs.map((z) => {
      const sec = S.section(z);
      const ptsK = [];
      for (let k = kFrom; k <= kTo; k++) ptsK.push(sec.pts[k]);
      // subdivide each key segment twice for curvature
      const row = [];
      for (let k = 0; k < ptsK.length - 1; k++) for (let t = 0; t < 3; t++) row.push([lerp(ptsK[k][0], ptsK[k + 1][0], t / 3), lerp(ptsK[k][1], ptsK[k + 1][1], t / 3)]);
      row.push(ptsK[ptsK.length - 1]);
      return row.filter((p) => p[0] >= xMin).map(([x, y]) => [side * x, y, z]);
    });
    const cols = Math.min(...rows.map((r) => r.length));
    rows.forEach((r) => { for (let c = 0; c < cols; c++) pos.push(...r[c]); });
    for (let i = 0; i < rows.length - 1; i++) for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c, b = a + 1, d = (i + 1) * cols + c, e = d + 1;
      if (side > 0) idx.push(a, b, d, b, e, d); else idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // lift along the normal so it sits on the paint without z-fighting
    const pa = g.attributes.position, na = g.attributes.normal;
    for (let i = 0; i < pa.count; i++) pa.setXYZ(i, pa.getX(i) + na.getX(i) * lift, pa.getY(i) + na.getY(i) * lift, pa.getZ(i) + na.getZ(i) * lift);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pa.count * 2), 2));
    return g;
  };
  return { S, paint: toGeo(out.paint), glass: toGeo(out.glass), surfaceStrip };
}

/**
 * Build all geometry pieces for a body type, grouped by material slot.
 * withInterior adds cabin parts (player car only).
 */
export function buildCarParts(typeName, { withInterior = false, lod = 0, electric = false } = {}) {
  const hi = lod === 0;
  const P = BODY_TYPES[typeName];
  const hl = P.L / 2;
  const parts = { paint: [], glass: [], trim: [], chrome: [], headLens: [], drl: [], tail: [], indicator: [], reverse: [], interior: [], leather: [], alu: [], plate: [] };
  const shell = buildShell(P, lod);
  const { S, surfaceStrip } = shell;
  const yTop = S.yTop;
  parts.paint.push(shell.paint);
  parts.glass.push(shell.glass);
  const gz0 = P.cabinZ0, gz1 = P.cabinZ1;

  // lights and details cut from the body surface
  const headZ = hl - 0.3;
  for (const s of [1, -1]) {
    parts.headLens.push(surfaceStrip(hl - 0.36, hl - 0.02, K.side, K.shoulder, s, 0.005, 0.46 * P.W / 2));
    // DRL: a thin light blade along the top edge of the lamp (a whole lit panel reads as a toy)
    const blade = stationsFor(hl - 0.33, hl - 0.05, hi ? 0.04 : 0.1).map((z) => { const [x, y] = S.section(z).pts[K.shoulder]; return new THREE.Vector3(s * (x + 0.002), y - 0.018, z + 0.004); });
    for (let i = 0; i < blade.length - 1; i++) parts.drl.push(beam(blade[i], blade[i + 1], 0.016, 0.012));
    parts.tail.push(surfaceStrip(-hl + 0.02, -hl + 0.24, K.shoulder, K.belt, s, 0.005, 0.45 * P.W / 2));
    parts.indicator.push(surfaceStrip(hl - 0.42, hl - 0.36, K.side, K.shoulder, s, 0.005, 0.7 * P.W / 2));
    if (hi || lod === 1) {
      // door shut lines and handles
      const doors = typeName === 'sport' ? [gz1 - 0.04, gz0 + 0.25] : [gz1 - 0.04, (gz0 + gz1) / 2 - 0.05, gz0 + 0.22];
      for (const z of doors) parts.trim.push(surfaceStrip(z, z + (hi ? 0.008 : 0.014), K.crease, K.belt, s, 0.002));
      for (const z of doors.slice(0, -1)) {
        const sec = S.section(z - 0.32);
        const [x, y] = sec.pts[K.shoulder];
        parts.chrome.push(box(0.018, 0.026, 0.15, s * (x + 0.006), y - 0.055, z - 0.32));
      }
      // thin bright trim along the window sill (beltline)
      const sill = stationsFor(gz0 + 0.08, gz1 - 0.08, 0.12).map((z) => { const [x, y] = S.section(z).pts[K.belt]; return new THREE.Vector3(s * (x + 0.004), y + 0.006, z); });
      for (let i = 0; i < sill.length - 1; i++) parts.chrome.push(beam(sill[i], sill[i + 1], 0.012, 0.014));
    }
    // mirrors on the door, just behind the A-pillar
    const mz = gz1 - 0.16, sec = S.section(mz);
    const [bx, by] = sec.pts[K.belt];
    const mx = s * (bx + 0.13), my = by + 0.075;
    parts.paint.push(box(0.2, 0.11, 0.13, mx, my, mz));
    parts.trim.push(beam(new THREE.Vector3(s * bx, by + 0.01, mz), new THREE.Vector3(mx - s * 0.06, my - 0.03, mz), 0.03, 0.025));
    parts.chrome.push(box(0.16, 0.08, 0.01, mx, my, mz - 0.07));
    parts.reverse.push(box(0.1, 0.035, 0.03, s * 0.36, P.clearance + 0.32, -hl + 0.02));
  }
  // rear light bar on the tail fascia and a lit badge-height strip
  parts.tail.push(box(P.W * 0.55, 0.02, 0.02, 0, yTop(-hl) - 0.07, -hl - 0.002));
  parts.plate.push(box(0.52, 0.11, 0.02, 0, P.clearance + 0.36, -hl - 0.006));
  parts.plate.push(box(0.52, 0.11, 0.02, 0, P.clearance + 0.17, hl + 0.006));

  // ---- trim: grille, intakes, diffuser, skirts, under-tub, wheel liners ----
  const grilleY = P.clearance + (typeName === 'sport' ? 0.26 : 0.32), grilleH = typeName === 'sport' ? 0.12 : 0.17;
  parts[electric ? 'paint' : 'trim'].push(box(P.W * 0.56, grilleH, 0.06, 0, grilleY, hl - 0.015));
  parts.trim.push(box(P.W * 0.74, 0.045, 0.2, 0, P.clearance + 0.05, hl - 0.12)); // lower lip
  parts.trim.push(box(P.W * 0.7, 0.12, 0.3, 0, P.clearance + 0.08, -hl + 0.18)); // diffuser
  for (const s of [1, -1]) {
    parts.trim.push(box(0.06, 0.08, P.wf - P.wr - P.archR * 2.1, s * (P.W / 2 - 0.04), P.clearance + 0.06, (P.wf + P.wr) / 2));
    for (const az of [P.wf, P.wr]) {
      const liner = new THREE.CylinderGeometry(P.archR, P.archR, 0.31, hi ? 20 : 8, 1, true, 0, Math.PI);
      liner.rotateZ(Math.PI / 2);
      liner.translate(s * (P.W / 2 - 0.26), P.r, az);
      parts.trim.push(liner);
    }
  }
  if (!withInterior) parts.trim.push(box(P.W * 0.62, Math.max(0.1, P.belt - P.clearance - 0.25), P.L * 0.8, 0, (P.belt + P.clearance) / 2 - 0.08, 0));
  if (hi) {
    // Inset intake slats and a separate lower lip keep the front fascia readable.
    const bars = electric ? 1 : 3;
    for (let i = 0; i < bars; i++) {
      parts.alu.push(box(P.W * 0.5, 0.01, 0.014, 0, grilleY + (i - (bars - 1) / 2) * (grilleH / (bars + 1)), hl + 0.016));
    }
  }
  // exhausts
  const ex = typeName === 'sport' ? [0.42, 0.56] : [0.5];
  if (!electric) for (const s of [1, -1]) for (const x of ex) parts.chrome.push(cyl(0.045, 0.12, s * x, P.clearance + 0.12, -hl + 0.03, 'z', 14));
  if (typeName === 'sport') parts.paint.push(box(P.W * 0.72, 0.03, 0.18, 0, yTop(-hl + 0.2) + 0.02, -hl + 0.2, -0.12)); // ducktail

  // ---- interior ----
  let driverEye = new THREE.Vector3(0.38, P.belt + 0.17, -0.3);
  if (withInterior) {
    const fy = P.clearance + 0.12;
    parts.interior.push(box(P.W * 0.82, 0.05, gz1 - gz0, 0, fy, (gz0 + gz1) / 2));
    // Dashboard and bulkhead seal the footwells below the windscreen.
    parts.interior.push(box(P.W * 0.83, P.belt - fy - 0.14, 0.09, 0, (fy + P.belt - 0.14) / 2, gz1 + 0.035));
    parts.interior.push(box(P.W * 0.7, 0.24, 0.2, 0, P.belt - 0.08, gz1 - 0.23));
    parts.interior.push(box(P.W * 0.7, 0.16, 0.16, 0, P.belt - 0.14, gz1 - 0.06));
    parts.leather.push(box(P.W * 0.69, 0.04, 0.2, 0, P.belt + 0.045, gz1 - 0.23, -0.1));
    parts.interior.push(box(0.32, 0.12, 0.16, 0.38, P.belt + 0.04, gz1 - 0.3, -0.3)); // binnacle
    parts.trim.push(box(0.30, 0.163, 0.038, 0.025, P.belt + 0.045, gz1 - 0.369, 0.15, 0.11));
    for (const x of [-0.33, -0.18, 0.62, -0.61]) {
      parts.trim.push(box(0.11, 0.048, 0.02, x, P.belt - 0.02, gz1 - 0.32));
      for (const y of [-0.012, 0, 0.012]) parts.alu.push(box(0.095, 0.003, 0.004, x, P.belt - 0.02 + y, gz1 - 0.333));
    }
    for (const x of [-0.052, 0, 0.052]) {
      parts.alu.push(cyl(0.015, 0.023, x, P.belt - 0.13, gz1 - 0.325));
    }
    for (const x of [0.29, 0.47]) parts.alu.push(box(0.066, 0.12, 0.017, x, fy + 0.14, gz1 - 0.02, -0.42));
    parts.interior.push(box(0.22, 0.25, gz1 - gz0 - 0.6, 0, fy + 0.15, (gz0 + gz1) / 2 + 0.1)); // console
    parts.alu.push(cyl(0.02, 0.08, 0, fy + 0.32, -0.1, 'y'));
    parts.leather.push(new THREE.SphereGeometry(0.043, 12, 8).scale(0.85, 1.15, 0.85).translate(0, fy + 0.37, -0.1));
    parts.leather.push(box(0.22, 0.075, 0.35, 0, fy + 0.29, -0.61));
    for (const s of [1, -1]) {
      parts.leather.push(box(0.5, 0.12, 0.52, s * 0.38, fy + 0.18, -0.2));
      parts.leather.push(box(0.5, 0.56, 0.12, s * 0.38, fy + 0.47, -0.5, 0.22));
      parts.leather.push(box(0.26, 0.15, 0.1, s * 0.38, fy + 0.8, -0.58, 0.22));
      const doorX = s * (P.W / 2 - 0.17);
      parts.leather.push(box(0.085, 0.067, 0.54, doorX, fy + 0.37, -0.19));
      parts.alu.push(box(0.036, 0.021, 0.13, doorX - s * 0.03, P.belt - 0.13, 0.14));
      parts.leather.push(box(0.085, 0.14, 0.48, s * 0.38 + 0.20, fy + 0.21, -0.2));
      parts.leather.push(box(0.085, 0.14, 0.48, s * 0.38 - 0.20, fy + 0.21, -0.2));
      // door cards
      parts.interior.push(box(0.04, P.belt - fy - 0.05, gz1 - gz0 - 0.5, s * (P.W / 2 - 0.16), (P.belt + fy) / 2, (gz0 + gz1) / 2 + 0.1));
    }
    if (gz0 < -1.4) {
      // rear bench, headrests and a parcel shelf: without them the rear glass shows an empty tub
      const rz = Math.max(gz0 + 0.55, -1.25);
      parts.leather.push(box(P.W * 0.7, 0.13, 0.5, 0, fy + 0.2, rz + 0.3));
      parts.leather.push(box(P.W * 0.7, 0.55, 0.12, 0, fy + 0.52, rz - 0.02, 0.18));
      for (const x of [-0.42, 0, 0.42]) parts.leather.push(box(0.22, 0.13, 0.09, x, fy + 0.86, rz - 0.07, 0.18));
      parts.interior.push(box(P.W * 0.76, 0.025, Math.max(0.1, rz - 0.1 - (gz0 + 0.06)), 0, P.belt + 0.01, (rz - 0.1 + gz0 + 0.06) / 2));
      parts.interior.push(box(P.W * 0.76, P.belt - fy, 0.04, 0, (P.belt + fy) / 2, gz0 + 0.08)); // boot bulkhead
    }
    parts.interior.push(box(0.2, 0.05, 0.03, 0, P.roofY - 0.08, P.roofZ1 + 0.05)); // rear-view mirror
    parts.alu.push(box(0.18, 0.034, 0.006, 0, P.roofY - 0.08, P.roofZ1 + 0.032));
    parts.leather.push(box(0.29, 0.021, 0.14, 0.38, P.roofY - 0.065, P.roofZ1 - 0.025));
    parts.leather.push(box(0.29, 0.021, 0.14, -0.38, P.roofY - 0.065, P.roofZ1 - 0.025));
    driverEye = new THREE.Vector3(0.38, P.roofY - 0.18, -0.29);
    parts.interior.push(box(P.W * 0.50, 0.018, Math.max(0.1, P.roofZ1 - P.roofZ0 - 0.12), 0, P.roofY - 0.05, (P.roofZ0 + P.roofZ1) / 2)); // headliner
  }

  return {
    params: P, parts, driverEye,
    headlights: [new THREE.Vector3(0.6, yTop(headZ) - 0.05, hl - 0.1), new THREE.Vector3(-0.6, yTop(headZ) - 0.05, hl - 0.1)],
    wheels: [
      { x: P.W / 2 - 0.16, z: P.wf, front: true }, { x: -(P.W / 2 - 0.16), z: P.wf, front: true },
      { x: P.W / 2 - 0.16, z: P.wr, front: false }, { x: -(P.W / 2 - 0.16), z: P.wr, front: false },
    ],
    steeringWheelPos: new THREE.Vector3(0.38, P.belt - 0.135, gz1 - 0.45),
  };
}

/** Wheel geometry: tyre + rim + brake disc, axis along X, outer face toward +X. */
export function buildWheelParts(r, width, style = 0, seg = 40) {
  const rimR = r * 0.7;
  const tireProfile = [
    [rimR, -width / 2], [r - 0.035, -width / 2], [r - 0.006, -width / 2 + 0.03], [r, -width / 2 + 0.06],
    [r, width / 2 - 0.06], [r - 0.006, width / 2 - 0.03], [r - 0.035, width / 2], [rimR, width / 2],
  ].map(([a, b]) => new THREE.Vector2(a, b));
  const tire = new THREE.LatheGeometry(tireProfile, seg);
  tire.rotateZ(-Math.PI / 2);
  const uv = tire.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i));

  const rimParts = [];
  const barrel = new THREE.LatheGeometry([
    new THREE.Vector2(rimR - 0.01, -width / 2 + 0.01), new THREE.Vector2(rimR + 0.012, -width / 2 + 0.015),
    new THREE.Vector2(rimR - 0.02, -width / 2 + 0.04), new THREE.Vector2(rimR - 0.02, width / 2 - 0.04),
    new THREE.Vector2(rimR + 0.012, width / 2 - 0.015), new THREE.Vector2(rimR - 0.01, width / 2 - 0.005),
  ], Math.max(12, seg - 8));
  barrel.rotateZ(-Math.PI / 2);
  rimParts.push(barrel);
  const face = width / 2 - 0.03;
  const hub = new THREE.CylinderGeometry(0.075, 0.085, 0.06, 16);
  hub.rotateZ(Math.PI / 2); hub.translate(face - 0.02, 0, 0);
  rimParts.push(hub);
  const spokes = style === 0 ? 10 : 6;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + (style === 0 && i % 2 ? 0.12 : 0);
    const s = new THREE.BoxGeometry(0.035, rimR - 0.07, style === 0 ? 0.03 : 0.06);
    s.translate(0, (rimR - 0.07) / 2 + 0.06, 0);
    s.rotateY(Math.PI / 2);
    s.rotateX(a);
    s.translate(face - 0.025, 0, 0);
    rimParts.push(s);
  }
  const rim = mergeGeometries(rimParts.map((g) => g.toNonIndexed()));
  const disc = new THREE.CylinderGeometry(rimR * 0.82, rimR * 0.82, 0.028, Math.max(12, seg - 12));
  disc.rotateZ(Math.PI / 2); disc.translate(face - 0.1, 0, 0);
  const caliper = new THREE.BoxGeometry(0.06, 0.15, 0.1);
  caliper.translate(face - 0.085, rimR * 0.58, -rimR * 0.3);
  return { tire, rim, disc, caliper };
}

function mergeSlot(list) {
  if (!list.length) return null;
  return mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    return g;
  }));
}

/** Player car: a THREE.Group with separate meshes for animated parts. */
export function createPlayerCar(M, type = 'sport', wheelWidth = 0.27, electric = false) {
  const built = buildCarParts(type, { withInterior: true, electric });
  const P = built.params;
  const root = new THREE.Group();
  root.name = 'playerCar';
  const body = new THREE.Group();
  root.add(body);
  const paint = M.paint.clone();
  const interior = M.interior.clone();
  const leather = M.leather.clone();
  interior.emissive.setHex(0x303a48);
  leather.emissive.setHex(0x584035);
  interior.emissiveIntensity = leather.emissiveIntensity = 0;
  const glass = M.carGlass.clone();
  glass.forceSinglePass = true;
  glass.envMapIntensity = 0.7;
  const headLens = M.headLens.clone(), drl = M.drl.clone(), tail = M.tail.clone(), ind = M.indicator.clone(), rev = M.reverse.clone();
  const slots = {
    paint, glass, trim: M.trim, chrome: M.chrome, headLens, drl, tail, indicator: ind, reverse: rev,
    interior, leather, alu: M.alu, plate: M.sign,
  };
  for (const [k, list] of Object.entries(built.parts)) {
    const g = mergeSlot(list);
    if (!g) continue;
    const mesh = new THREE.Mesh(g, slots[k]);
    mesh.castShadow = ['paint', 'trim'].includes(k);
    mesh.receiveShadow = true;
    if (k === 'glass') mesh.renderOrder = 2;
    mesh.name = k;
    body.add(mesh);
  }
  // steering wheel
  const sw = new THREE.Group();
  const rimG = new THREE.TorusGeometry(0.175, 0.018, 10, 40);
  const swMesh = new THREE.Mesh(rimG, leather);
  sw.add(swMesh);
  const hubPad = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), interior);
  hubPad.scale.set(0.085, 0.064, 0.033);
  hubPad.position.z = -0.018;
  sw.add(hubPad);
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.015), M.alu);
    sp.position.set(Math.sin(a) * 0.085, -Math.cos(a) * 0.085, 0);
    sp.rotation.z = a;
    sw.add(sp);
  }
  const swPivot = new THREE.Group();
  swPivot.position.copy(built.steeringWheelPos);
  swPivot.rotation.x = -0.38;
  swPivot.add(sw);
  body.add(swPivot);

  const display = document.createElement('canvas');
  display.width = 384;
  display.height = 128;
  const ctx = display.getContext('2d');
  const texture = new THREE.CanvasTexture(display);
  texture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.29, 0.097), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  screen.rotation.set(0.15, Math.PI, 0, 'YXZ');
  screen.position.set(0.38, P.belt + 0.067, P.cabinZ1 - 0.407);
  body.add(screen);
  const navigation = createNavDisplay(P);
  body.add(navigation.screen);

  let previousReadout = '';
  function updateCluster(speed, rpm, gear, imperial) {
    const kmh = Math.round(Math.abs(speed) * (imperial ? 2.237 : 3.6));
    const rev = Math.round(rpm / 200);
    const readout = [kmh, rev, gear, imperial].join('/');
    if (readout === previousReadout) return;
    previousReadout = readout;
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, 384, 128);
    ctx.fillStyle = '#283747';
    ctx.fillRect(24, 22, 336, 8);
    ctx.fillStyle = rev >= 35 ? '#ff715c' : '#8bd7ff';
    ctx.fillRect(24, 22, 336 * clamp(rev / 40, 0, 1), 8);
    ctx.fillStyle = '#e4f4ff';
    ctx.font = 'bold 64px monospace';
    ctx.fillText(kmh, 26, 94);
    ctx.font = 'bold 23px sans-serif';
    ctx.fillText(imperial ? 'MPH' : 'KM/H', 157, 91);
    ctx.font = 'bold 47px monospace';
    ctx.fillText(gear < 0 ? 'R' : gear === 0 ? 'N' : electric ? 'D' : gear, 308, 91);
    texture.needsUpdate = true;
  }
  updateCluster(0, 850, 1, false);

  // wheels
  const rider = new THREE.Group();
  const jacket = new THREE.MeshStandardMaterial({ color: 0x526d83, roughness: 0.9 });
  const complexion = new THREE.MeshStandardMaterial({ color: 0xa57656, roughness: 0.85 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, 0.19, 4, 8), jacket);
  torso.position.y = P.clearance + 0.67;
  const riderHead = new THREE.Mesh(new THREE.SphereGeometry(0.105, 10, 8), complexion);
  riderHead.scale.y = 1.16;
  riderHead.position.set(0, Math.min(P.roofY - 0.19, P.clearance + 0.99), 0.04);
  rider.position.set(-0.38, 0, -0.30);
  rider.add(torso, riderHead);
  rider.visible = false;
  body.add(rider);
  const wp = buildWheelParts(P.r, wheelWidth, type === 'sport' ? 0 : 1);
  const wheels = built.wheels.map((w) => {
    const hub = new THREE.Group(); // steering pivot
    hub.position.set(w.x, P.r, w.z);
    const spin = new THREE.Group();
    const flip = w.x < 0;
    const mk = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; return m; };
    spin.add(mk(wp.tire, M.tire), mk(wp.rim, M.rim), mk(wp.disc, M.disc));
    const cal = mk(wp.caliper, M.caliper);
    const inner = new THREE.Group();
    inner.add(spin, cal);
    if (flip) inner.rotation.y = Math.PI;
    hub.add(inner);
    root.add(hub);
    return { hub, spin, flip, base: new THREE.Vector3(w.x, P.r, w.z) };
  });

  return {
    root, body, wheels, rider, navigation, cluster: screen, updateCluster, steering: sw, driverEye: built.driverEye, params: P,
    materials: { paint, glass, headLens, drl, tail, indicator: ind, reverse: rev, interior, leather },
    headlightPos: built.headlights,
  };
}

export function disposeCarModel(model) {
  model.root.removeFromParent();
  const geometries = new Set();
  model.root.traverse((object) => { if (object.geometry) geometries.add(object.geometry); });
  for (const geometry of geometries) geometry.dispose();
  for (const material of Object.values(model.materials)) material.dispose();
  for (const part of model.rider.children) part.material.dispose();
  for (const screen of [model.cluster, model.navigation.screen]) {
    screen.material.map.dispose();
    screen.material.dispose();
  }
}

/** Merged geometry per material slot for instanced NPC rendering. */
export function createNpcGeometry(typeName, lod = 1) {
  const built = buildCarParts(typeName, { withInterior: false, lod });
  const g = {};
  const p = built.parts;
  g.paint = mergeSlot(p.paint);
  g.glass = mergeSlot(p.glass);
  g.trim = mergeSlot([...p.trim, ...p.chrome, ...p.reverse, ...p.plate]);
  g.lightF = mergeSlot([...p.headLens, ...p.drl, ...p.indicator.slice(0, 2)]);
  g.lightR = mergeSlot([...p.tail]);
  const wp = buildWheelParts(built.params.r, 0.24, 1, lod === 1 ? 14 : 10);
  g.tire = wp.tire;
  g.rim = mergeSlot([wp.rim, wp.disc]);
  return { geo: g, params: built.params, wheels: built.wheels, headlights: built.headlights };
}
