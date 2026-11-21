// Pure-data city layout: road network, lane graph, blocks, buildings and prop placements.
// No rendering or physics here, so it can be unit-tested headlessly.
import { RNG, clamp, smoothstep } from '../core/rng.js';

export const CITY = {
  N: 8,               // blocks per side
  pitch: 100,         // grid spacing (m)
  half: 400,          // grid extends -half..half
  curb: 0.15,
};
export const RING = { offset: 520, cornerR: 90, halfWidth: 11, laneW: 3.75, median: 1.0 };
export const BOULEVARD = { y: 8.5, upA: 410, upB: 505, downA: 535, downB: 630, endX: 1148 };
export const ROUNDABOUT = { x: 1180, z: 0, island: 20, lane: 26, outer: 32 };
export const TUNNEL = { x0: -360, x1: -140, z: -520, archW: 26, archH: 8.5 };

export const SURF = { GROUND: 0, ROAD: 1, SIDEWALK: 2, PARK: 3, BUILDING: 4, PARKING: 5, HIGHWAY: 6, YARD: 7 };
export const SURFACE_PROPS = {
  0: { mu: 0.62, roll: 0.05, bump: 0.018, name: 'grass' },
  1: { mu: 1.0, roll: 0.012, bump: 0.0, name: 'asphalt' },
  2: { mu: 0.95, roll: 0.014, bump: 0.002, name: 'concrete' },
  3: { mu: 0.6, roll: 0.05, bump: 0.015, name: 'grass' },
  4: { mu: 0.9, roll: 0.02, bump: 0.0, name: 'concrete' },
  5: { mu: 0.98, roll: 0.013, bump: 0.0, name: 'asphalt' },
  6: { mu: 1.02, roll: 0.011, bump: 0.0, name: 'asphalt' },
  7: { mu: 0.8, roll: 0.025, bump: 0.008, name: 'gravel' },
};

export const isArterial = (i) => i % 4 === 0;
export const gridLine = (i) => -CITY.half + i * CITY.pitch;
export const roadHalf = (i) => (isArterial(i) ? 7 : 5.5);
export const sidewalkW = (i) => (isArterial(i) ? 4 : 3);
export const lanesPerDir = (i) => (isArterial(i) ? 2 : 1);
export const laneOffsets = (i) => (isArterial(i) ? [1.75, 5.25] : [1.9]);

export function boulevardY(x) {
  const B = BOULEVARD;
  return B.y * (smoothstep(B.upA, B.upB, x) - smoothstep(B.downA, B.downB, x));
}

export function districtOf(x, z) {
  if (x > CITY.half + 60) return 'highway';
  if (Math.abs(x) > CITY.half + 40 || Math.abs(z) > CITY.half + 40) return 'highway';
  if (Math.abs(x) < 200 && Math.abs(z) < 200) return 'downtown';
  if (x < -200) return 'residential';
  if (z > 200) return 'industrial';
  if (z < -200) return 'residential';
  return 'commercial';
}
export const DISTRICT_NAMES = {
  downtown: 'Downtown Meridian',
  residential: 'Westbrook Residential',
  industrial: 'Port Industrial',
  commercial: 'Eastside Commercial',
  highway: 'Ring Expressway',
};

// ---------- geometry helpers ----------
export function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

function bezier(p0, p1, p2, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
      u * u * p0[2] + 2 * u * t * p1[2] + t * t * p2[2],
    ]);
  }
  return out;
}

/** Rounded-rectangle loop centerline for the ring expressway (clockwise when seen from above with +z down). */
export function ringCenterline(step = 6) {
  const o = RING.offset, r = RING.cornerR, s = o - r;
  const pts = [];
  // corners in order: (+x,+z) -> (-x,+z) -> (-x,-z) -> (+x,-z)
  const corners = [
    { cx: s, cz: s, a0: 0, a1: Math.PI / 2 },
    { cx: -s, cz: s, a0: Math.PI / 2, a1: Math.PI },
    { cx: -s, cz: -s, a0: Math.PI, a1: 1.5 * Math.PI },
    { cx: s, cz: -s, a0: 1.5 * Math.PI, a1: 2 * Math.PI },
  ];
  for (let c = 0; c < 4; c++) {
    const { cx, cz, a0, a1 } = corners[c];
    const arcN = Math.ceil((r * (a1 - a0)) / step);
    for (let i = 0; i < arcN; i++) {
      const a = a0 + ((a1 - a0) * i) / arcN;
      pts.push([cx + r * Math.cos(a), 0, cz + r * Math.sin(a)]);
    }
    // straight to next corner
    const n = corners[(c + 1) % 4];
    const e = [cx + r * Math.cos(a1), 0, cz + r * Math.sin(a1)];
    const f = [n.cx + r * Math.cos(n.a0), 0, n.cz + r * Math.sin(n.a0)];
    const L = Math.hypot(f[0] - e[0], f[2] - e[2]);
    const sn = Math.ceil(L / step);
    for (let i = 0; i < sn; i++) {
      const t = i / sn;
      pts.push([e[0] + (f[0] - e[0]) * t, 0, e[2] + (f[2] - e[2]) * t]);
    }
  }
  return pts; // closed implicitly
}

export function offsetPolyline(pts, off, closed = false) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[2] - a[2];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    // right-hand vector (driving on the right): right = (-tz, 0, tx)
    out.push([pts[i][0] - tz * off, pts[i][1], pts[i][2] + tx * off]);
  }
  return out;
}

// ---------- main builder ----------
export function buildLayout(seed = 1337) {
  const rng = new RNG(seed);
  const N = CITY.N;
  const L = {
    intersections: [], roads: [], paths: [], blocks: [], buildings: [],
    props: {
      streetlights: [], trees: [], benches: [], bins: [], busStops: [], meters: [], hydrants: [],
      utilityPoles: [], stopSigns: [], speedSigns: [], billboards: [], fences: [], barriers: [],
      gantries: [], signals: [], parkedCars: [], containers: [], bollards: [], tunnelLamps: [], grass: [],
      speedBumps: [], crosswalks: [], stallLines: [],
      decals: [], clutter: [], construction: [],
    },
    ring: null, boulevard: null,
  };
  const P = L.props;

  // ----- intersections -----
  const interId = (i, j) => i * (N + 1) + j;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const signal = isArterial(i) || isArterial(j);
      const green = rng.float(11, 16);
      const cycle = 2 * (green + 3 + 1.5);
      L.intersections.push({
        id: interId(i, j), i, j, x: gridLine(i), z: gridLine(j),
        halfX: roadHalf(i), halfZ: roadHalf(j),
        type: signal ? 'signal' : 'stop',
        green, cycle, offset: rng.float(0, cycle),
        incoming: [], outgoing: [],
      });
    }
  }
  const inter = (i, j) => L.intersections[interId(i, j)];

  // ----- paths (lane graph) -----
  const addPath = (pts, meta) => {
    const cum = [0];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      cum.push(cum[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const p = { id: L.paths.length, pts, cum, len: cum[cum.length - 1], next: [], ...meta };
    L.paths.push(p);
    return p;
  };

  // grid roads
  for (let line = 0; line <= N; line++) {
    for (let k = 0; k < N; k++) {
      // road along z at x-line `line`, between (line,k) and (line,k+1)
      L.roads.push({ axis: 'z', line, a: inter(line, k), b: inter(line, k + 1), half: roadHalf(line), sw: sidewalkW(line), arterial: isArterial(line) });
      // road along x at z-line `line`, between (k,line) and (k+1,line)
      L.roads.push({ axis: 'x', line, a: inter(k, line), b: inter(k + 1, line), half: roadHalf(line), sw: sidewalkW(line), arterial: isArterial(line) });
    }
  }

  const SETBACK = 4.5; // stop line distance beyond the cross road edge (room for crosswalk)
  for (const r of L.roads) {
    const offs = laneOffsets(r.line);
    for (const dir of [1, -1]) {
      const A = dir === 1 ? r.a : r.b, B = dir === 1 ? r.b : r.a;
      const d = r.axis === 'x' ? [dir, 0, 0] : [0, 0, dir];
      const right = [-d[2], 0, d[0]];
      const crossA = r.axis === 'x' ? A.halfX : A.halfZ;
      const crossB = r.axis === 'x' ? B.halfX : B.halfZ;
      offs.forEach((off, k) => {
        const s = [A.x + d[0] * (crossA + SETBACK) + right[0] * off, 0, A.z + d[2] * (crossA + SETBACK) + right[2] * off];
        const e = [B.x - d[0] * (crossB + SETBACK) + right[0] * off, 0, B.z - d[2] * (crossB + SETBACK) + right[2] * off];
        const p = addPath([s, e], { kind: 'lane', axis: r.axis, dir: d, lane: k, nLanes: offs.length, endInter: B.id, startInter: A.id, speed: r.arterial ? 15 : 11 });
        B.incoming.push(p.id);
        A.outgoing.push(p.id);
      });
    }
  }

  // ----- east boulevard (with overpass) and roundabout -----
  const eastI = inter(N, N / 2); // (400, 0)
  {
    const x0 = eastI.x + eastI.halfX + SETBACK, x1 = BOULEVARD.endX - 2;
    const sample = (xa, xb, off) => {
      const pts = [];
      const n = Math.ceil(Math.abs(xb - xa) / 4);
      for (let k = 0; k <= n; k++) {
        const x = xa + ((xb - xa) * k) / n;
        pts.push([x, boulevardY(x), off]);
      }
      return pts;
    };
    const offs = [1.75, 5.25];
    const eb = [], wb = [];
    offs.forEach((off, k) => {
      // eastbound: d = +x, right = (0,0,1) -> +z
      const pe = addPath(sample(x0, x1, off), { kind: 'lane', axis: 'x', dir: [1, 0, 0], lane: k, nLanes: 2, startInter: eastI.id, endInter: -1, speed: 22 });
      eastI.outgoing.push(pe.id); eb.push(pe);
      // westbound: d = -x, right = (0,0,-1) -> -z
      const pw = addPath(sample(x1, x0, -off), { kind: 'lane', axis: 'x', dir: [-1, 0, 0], lane: k, nLanes: 2, startInter: -1, endInter: eastI.id, speed: 22 });
      eastI.incoming.push(pw.id); wb.push(pw);
    });
    L.boulevard = { x0: eastI.x + eastI.halfX, x1: BOULEVARD.endX + 6, half: 7, eb: eb.map((p) => p.id), wb: wb.map((p) => p.id) };

    // roundabout turnaround: entry bezier + arc + exit bezier
    const R = ROUNDABOUT;
    for (let k = 0; k < 2; k++) {
      const pin = eb[k], pout = wb[k];
      const a = pin.pts[pin.pts.length - 1];
      const b = pout.pts[0];
      const th0 = Math.PI - 0.42, th1 = -Math.PI + 0.42;
      const arcStart = [R.x + R.lane * Math.cos(th0), 0, R.z + R.lane * Math.sin(th0)];
      const arcEnd = [R.x + R.lane * Math.cos(th1), 0, R.z + R.lane * Math.sin(th1)];
      const pts = bezier(a, [a[0] + 8, 0, a[2]], arcStart, 8);
      const n = 48;
      for (let s = 1; s <= n; s++) {
        const th = th0 + ((th1 - th0) * s) / n;
        pts.push([R.x + R.lane * Math.cos(th), 0, R.z + R.lane * Math.sin(th)]);
      }
      const exitPts = bezier(arcEnd, [b[0] + 8, 0, b[2]], b, 8);
      for (let s = 1; s < exitPts.length; s++) pts.push(exitPts[s]);
      const c = addPath(pts, { kind: 'connector', turn: 'U', inter: -1, speed: 9 });
      pin.next.push(c.id);
      c.next.push(pout.id);
    }
  }

  // ----- intersection connectors -----
  const same = (a, b) => a[0] === b[0] && a[2] === b[2];
  for (const I of L.intersections) {
    for (const inId of I.incoming) {
      const pin = L.paths[inId];
      const d = pin.dir;
      const right = [-d[2], 0, d[0]];
      const left = [d[2], 0, -d[0]];
      for (const outId of I.outgoing) {
        const pout = L.paths[outId];
        const d2 = pout.dir;
        let turn = null;
        // corner intersections only allow one turn, so every lane may take it there
        const corner = I.outgoing.every((o) => !same(L.paths[o].dir, d)) && I.outgoing.filter((o) => L.paths[o].lane === 0).length === 2;
        const sameLane = pout.lane === Math.min(pin.lane, pout.nLanes - 1);
        if (same(d2, d) && sameLane) turn = 'S';
        else if (same(d2, right) && ((pin.lane === pin.nLanes - 1 && pout.lane === pout.nLanes - 1) || (corner && sameLane))) turn = 'R';
        else if (same(d2, left) && ((pin.lane === 0 && pout.lane === 0) || (corner && sameLane))) turn = 'L';
        if (turn && corner && same(d2, [-d[0], 0, -d[2]])) turn = null;
        if (!turn) continue;
        const p0 = pin.pts[pin.pts.length - 1];
        const p2 = pout.pts[0];
        let p1;
        if (turn === 'S') p1 = [(p0[0] + p2[0]) / 2, 0, (p0[2] + p2[2]) / 2];
        else {
          const t = (p2[0] - p0[0]) * d[0] + (p2[2] - p0[2]) * d[2];
          p1 = [p0[0] + d[0] * t, 0, p0[2] + d[2] * t];
        }
        const c = addPath(bezier(p0, p1, p2, turn === 'S' ? 4 : 10), { kind: 'connector', turn, inter: I.id, speed: turn === 'S' ? 12 : 7 });
        pin.next.push(c.id);
        c.next.push(pout.id);
      }
    }
  }

  // ----- ring expressway loops -----
  const center = ringCenterline(6);
  L.ring = { center, loops: [] };
  const ringOffs = [RING.median + RING.laneW / 2, RING.median + RING.laneW * 1.5];
  for (const off of ringOffs) {
    const fwd = offsetPolyline(center, off, true);
    fwd.push(fwd[0]);
    const pf = addPath(fwd, { kind: 'ring', speed: 27 });
    pf.next.push(pf.id);
    const rev = center.slice().reverse();
    const bw = offsetPolyline(rev, off, true);
    bw.push(bw[0]);
    const pb = addPath(bw, { kind: 'ring', speed: 25 });
    pb.next.push(pb.id);
    L.ring.loops.push(pf.id, pb.id);
  }

  // ----- blocks and buildings -----
  for (let bx = 0; bx < N; bx++) {
    for (let bz = 0; bz < N; bz++) {
      const x0 = gridLine(bx) + roadHalf(bx), x1 = gridLine(bx + 1) - roadHalf(bx + 1);
      const z0 = gridLine(bz) + roadHalf(bz), z1 = gridLine(bz + 1) - roadHalf(bz + 1);
      const ix0 = x0 + sidewalkW(bx), ix1 = x1 - sidewalkW(bx + 1);
      const iz0 = z0 + sidewalkW(bz), iz1 = z1 - sidewalkW(bz + 1);
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const district = districtOf(cx, cz);
      let type;
      if (district === 'downtown') type = bx === 4 && bz === 3 ? 'park' : rng.weighted([['towers', 0.9], ['plaza', 0.1]]);
      else if (district === 'commercial') type = rng.weighted([['midrise', 0.72], ['park', 0.28]]);
      else if (district === 'residential') type = rng.weighted([['houses', 0.58], ['apartments', 0.3], ['park', 0.12]]);
      else type = rng.weighted([['warehouses', 0.5], ['parking', 0.25], ['factory', 0.25]]);
      const block = { bx, bz, x0, x1, z0, z1, ix0, ix1, iz0, iz1, cx, cz, district, type };
      L.blocks.push(block);
      planBlock(block, L, rng);
    }
  }

  planStreetProps(L, rng);
  planStreetDetail(L, new RNG(seed + 7));
  planHighwayProps(L, rng);
  L.raster = buildRaster(L);
  L.surfaceAt = (x, z) => surfaceAt(L.raster, x, z);
  return L;
}

// ---------- block planning ----------
function addBuilding(L, b) { L.buildings.push(b); }

function planBlock(B, L, rng) {
  const P = L.props;
  const W = B.ix1 - B.ix0, D = B.iz1 - B.iz0;
  const seed = () => rng.next();
  switch (B.type) {
    case 'towers': {
      const dist = Math.hypot(B.cx, B.cz);
      const split = rng.weighted([[1, 0.2], [2, 0.45], [4, 0.35]]);
      const parcels = [];
      const gap = 0.4; // prewar blocks are built wall-to-wall
      if (split === 1) parcels.push([B.ix0, B.iz0, B.ix1, B.iz1]);
      else if (split === 2) {
        if (rng.chance(0.5)) { const m = B.ix0 + W * rng.float(0.4, 0.6); parcels.push([B.ix0, B.iz0, m - gap / 2, B.iz1], [m + gap / 2, B.iz0, B.ix1, B.iz1]); }
        else { const m = B.iz0 + D * rng.float(0.4, 0.6); parcels.push([B.ix0, B.iz0, B.ix1, m - gap / 2], [B.ix0, m + gap / 2, B.ix1, B.iz1]); }
      } else {
        const mx = B.ix0 + W * rng.float(0.42, 0.58), mz = B.iz0 + D * rng.float(0.42, 0.58);
        parcels.push([B.ix0, B.iz0, mx - gap / 2, mz - gap / 2], [mx + gap / 2, B.iz0, B.ix1, mz - gap / 2], [B.ix0, mz + gap / 2, mx - gap / 2, B.iz1], [mx + gap / 2, mz + gap / 2, B.ix1, B.iz1]);
      }
      for (const [a0, c0, a1, c1] of parcels) {
        const inset = rng.float(0.3, 1.2);
        const px0 = a0 + inset, px1 = a1 - inset, pz0 = c0 + inset, pz1 = c1 - inset;
        const w = px1 - px0, d = pz1 - pz0;
        if (w < 8 || d < 8) continue;
        const centrality = clamp(1 - dist / 260, 0, 1);
        const style = rng.weighted([['prewar', 0.5], ['limestone', 0.28], ['glass', 0.1 + centrality * 0.2]]);
        const h = rng.float(32, 55) + centrality * rng.float(30, 95) * (split === 4 ? 0.8 : 1);
        const x = (px0 + px1) / 2, z = (pz0 + pz1) / 2;
        if (style === 'glass') {
          const podium = rng.float(10, 16);
          addBuilding(L, { x, z, w, d, y0: 0, h: podium, style: 'limestone', cornice: true, seed: seed() });
          const tw = w * rng.float(0.65, 0.85), td = d * rng.float(0.65, 0.85);
          addBuilding(L, { x, z, w: tw, d: td, y0: podium, h: h + 15, style, seed: seed() });
          roofUnits(L, rng, x, z, tw, td, podium + h + 15);
        } else if (h > 60 && rng.chance(0.65)) {
          // wedding-cake setback: full-footprint base, narrower tower above
          const h1 = rng.float(0.45, 0.65) * h;
          addBuilding(L, { x, z, w, d, y0: 0, h: h1, style, cornice: true, seed: seed() });
          const tw = w * rng.float(0.62, 0.8), td = d * rng.float(0.62, 0.8);
          const ox = rng.float(-0.4, 0.4) * (w - tw), oz = rng.float(-0.4, 0.4) * (d - td);
          addBuilding(L, { x: x + ox, z: z + oz, w: tw, d: td, y0: h1, h: h - h1, style, cornice: true, tank: rng.chance(0.55), seed: seed() });
          L.buildings[L.buildings.length - 1].baseless = true;
        } else {
          addBuilding(L, { x, z, w, d, y0: 0, h, style, cornice: true, tank: rng.chance(0.5), seed: seed() });
        }
      }
      break;
    }
    case 'plaza':
    case 'park': {
      // trees scattered with a cross path
      const n = Math.floor((W * D) / 140);
      for (let k = 0; k < n; k++) {
        const x = rng.float(B.ix0 + 3, B.ix1 - 3), z = rng.float(B.iz0 + 3, B.iz1 - 3);
        const onPath = Math.abs(x - B.cx) < 3 || Math.abs(z - B.cz) < 3;
        if (onPath) continue;
        P.trees.push({ x, z, s: rng.float(0.8, 1.35), kind: rng.int(0, 2) });
      }
      for (let k = 0; k < 6; k++) {
        const along = rng.chance(0.5);
        const x = along ? B.cx + 4 : rng.float(B.ix0 + 6, B.ix1 - 6);
        const z = along ? rng.float(B.iz0 + 6, B.iz1 - 6) : B.cz + 4;
        P.benches.push({ x, z, rot: along ? Math.PI / 2 : 0 });
      }
      P.bins.push({ x: B.cx + 4, z: B.cz + 4 });
      P.grass.push({ x0: B.ix0, z0: B.iz0, x1: B.ix1, z1: B.iz1, density: 0.55 });
      break;
    }
    case 'midrise': {
      // continuous street wall of attached mid-rise buildings, light-well courtyard behind
      const depth = rng.float(18, 24);
      const sides = [
        { x0: B.ix0, x1: B.ix1, z0: B.iz0, z1: B.iz0 + depth, axis: 'x' },
        { x0: B.ix0, x1: B.ix1, z0: B.iz1 - depth, z1: B.iz1, axis: 'x' },
        { x0: B.ix0, x1: B.ix0 + depth, z0: B.iz0 + depth + 0.2, z1: B.iz1 - depth - 0.2, axis: 'z' },
        { x0: B.ix1 - depth, x1: B.ix1, z0: B.iz0 + depth + 0.2, z1: B.iz1 - depth - 0.2, axis: 'z' },
      ];
      for (const s of sides) {
        const len = s.axis === 'x' ? s.x1 - s.x0 : s.z1 - s.z0;
        let cur = 0;
        while (cur < len - 6) {
          const seg = Math.min(len - cur, rng.float(12, 26));
          const style = rng.weighted([['prewar', 0.3], ['loft', 0.35], ['limestone', 0.15], ['tenement', 0.2]]);
          const h = style === 'loft' ? rng.float(18, 32) : rng.float(16, 34);
          const fe = (style === 'tenement' || style === 'loft') && rng.chance(0.6);
          const b = { y0: 0, h, style, cornice: true, fe, tank: rng.chance(0.35), seed: seed() };
          if (s.axis === 'x') addBuilding(L, { ...b, x: s.x0 + cur + seg / 2, z: (s.z0 + s.z1) / 2, w: seg - 0.15, d: s.z1 - s.z0 });
          else addBuilding(L, { ...b, x: (s.x0 + s.x1) / 2, z: s.z0 + cur + seg / 2, w: s.x1 - s.x0, d: seg - 0.15 });
          cur += seg;
        }
      }
      break;
    }
    case 'houses': {
      // attached brownstone / brick row houses along both long sides, gardens behind
      for (const side of [-1, 1]) {
        let x = B.ix0;
        const d = rng.float(13, 16);
        while (x < B.ix1 - 6) {
          const w = Math.min(B.ix1 - x, rng.float(6.5, 9));
          const style = rng.weighted([['brownstone', 0.6], ['tenement', 0.4]]);
          const h = rng.float(10.5, 16.5);
          const z = side < 0 ? B.iz0 + 2.5 + d / 2 : B.iz1 - 2.5 - d / 2;
          addBuilding(L, { x: x + w / 2, z, w: w - 0.1, d, y0: 0, h, style, cornice: true, fe: style === 'tenement' && rng.chance(0.3), seed: seed() });
          x += w;
        }
      }
      for (let k = 0; k < 6; k++) P.trees.push({ x: rng.float(B.ix0 + 4, B.ix1 - 4), z: B.cz + rng.float(-6, 6), s: rng.float(0.8, 1.2), kind: rng.int(0, 2) });
      P.fences.push({ x0: B.ix0 + 1, z0: B.cz, x1: B.ix1 - 1, z1: B.cz, kind: 'wood' });
      P.grass.push({ x0: B.ix0, z0: B.iz0, x1: B.ix1, z1: B.iz1, density: 0.35 });
      break;
    }
    case 'apartments': {
      // tenement blocks: 5-7 storey walk-ups with fire escapes
      const d = rng.float(16, 20);
      for (const z of [B.iz0 + d / 2 + 0.5, B.iz1 - d / 2 - 0.5]) {
        let x = B.ix0;
        while (x < B.ix1 - 8) {
          const w = Math.min(B.ix1 - x, rng.float(12, 20));
          addBuilding(L, { x: x + w / 2, z, w: w - 0.1, d, y0: 0, h: rng.float(16, 23), style: 'tenement', cornice: true, fe: rng.chance(0.8), tank: rng.chance(0.3), seed: seed() });
          x += w;
        }
      }
      for (let k = 0; k < 5; k++) P.trees.push({ x: rng.float(B.ix0 + 4, B.ix1 - 4), z: B.cz + rng.float(-6, 6), s: rng.float(0.8, 1.2), kind: rng.int(0, 2) });
      for (let k = 0; k < 3; k++) P.benches.push({ x: rng.float(B.ix0 + 8, B.ix1 - 8), z: B.cz, rot: 0 });
      P.grass.push({ x0: B.ix0, z0: B.iz0, x1: B.ix1, z1: B.iz1, density: 0.3 });
      break;
    }
    case 'warehouses':
    case 'factory': {
      const n = B.type === 'factory' ? 1 : rng.int(1, 2);
      const w = (W - 12) / n;
      for (let k = 0; k < n; k++) {
        const bw = w - 6, bd = rng.float(D * 0.45, D * 0.6), h = rng.float(9, 15);
        const x = B.ix0 + 6 + w * (k + 0.5), z = B.iz0 + 6 + bd / 2;
        addBuilding(L, { x, z, w: bw, d: bd, y0: 0, h: h + rng.float(4, 12), style: 'factory', cornice: true, tank: rng.chance(0.6), fe: rng.chance(0.3), seed: seed() });
      }
      if (B.type === 'factory') {
        for (let k = 0; k < rng.int(1, 3); k++) addBuilding(L, { x: B.ix0 + 12 + k * 9, z: B.iz1 - 14, w: 4, d: 4, y0: 0, h: rng.float(28, 42), style: 'plain', shape: 'cyl', seed: seed() });
        for (let k = 0; k < 3; k++) addBuilding(L, { x: B.ix1 - 12 - k * 13, z: B.iz1 - 14, w: 10, d: 10, y0: 0, h: rng.float(9, 14), style: 'metal', shape: 'cyl', seed: seed() });
      }
      // yard containers
      const cols = [0x8a2b20, 0x1f4f7a, 0x2f6d3a, 0x9b6b1f, 0x5a5f66, 0x7a2f55];
      for (let k = 0; k < 10; k++) {
        const x = rng.float(B.ix0 + 8, B.ix1 - 8), z = rng.float(B.iz1 - 34, B.iz1 - 24);
        const stack = rng.chance(0.3) ? 2 : 1;
        for (let s = 0; s < stack; s++) P.containers.push({ x, z, y: s * 2.6, rot: rng.chance(0.5) ? 0 : Math.PI / 2, color: rng.pick(cols) });
      }
      // perimeter fence with a gate gap facing the north street
      P.fences.push({ x0: B.ix0 + 1, z0: B.iz1 - 1, x1: B.ix1 - 1, z1: B.iz1 - 1, kind: 'chain' });
      P.fences.push({ x0: B.ix0 + 1, z0: B.iz0 + 1, x1: B.ix0 + 1, z1: B.iz1 - 1, kind: 'chain' });
      P.fences.push({ x0: B.ix1 - 1, z0: B.iz0 + 1, x1: B.ix1 - 1, z1: B.iz1 - 1, kind: 'chain' });
      break;
    }
    case 'parking': {
      // stalls in rows, parked cars, lamp posts
      const rows = [];
      for (let z = B.iz0 + 8; z < B.iz1 - 8; z += 16) rows.push(z);
      for (const z of rows) {
        for (let x = B.ix0 + 4; x < B.ix1 - 4; x += 2.8) {
          for (const side of [-1, 1]) {
            P.stallLines.push({ x, z: z + side * 2.6, rot: 0 });
            if (rng.chance(0.42)) P.parkedCars.push({ x: x + 1.4, y: CITY.curb, z: z + side * 2.6, rot: side > 0 ? 0 : Math.PI, variant: rng.int(0, 3), color: rng.next() });
          }
        }
        P.streetlights.push({ x: B.cx, z, rot: 0, kind: 'lot', y: CITY.curb });
      }
      break;
    }
  }
}

function roofUnits(L, rng, x, z, w, d, top) {
  const n = rng.int(1, 3);
  for (let k = 0; k < n; k++) {
    const uw = rng.float(3, Math.min(9, w * 0.4)), ud = rng.float(3, Math.min(9, d * 0.4));
    L.buildings.push({
      x: x + rng.float(-0.5, 0.5) * (w - uw), z: z + rng.float(-0.5, 0.5) * (d - ud),
      w: uw, d: ud, y0: top, h: rng.float(2.5, 5), style: 'metal', seed: rng.next(),
    });
  }
}

// ---------- street detail: decals, clutter, construction ----------
// decal cells match DECAL in render/textures.js
const DC = { manhole: 0, grate: 1, oil: 2, patch: 3, arrowS: 4, arrowL: 5, arrowR: 6, crack: 7, paper: 8, can: 9, leaves: 10, stain: 11, gum: 12, seam: 13, utility: 14 };
function planStreetDetail(L, rng) {
  const P = L.props;
  const curb = CITY.curb;
  const dec = (cell, x, y, z, w, l, rot) => P.decals.push({ cell, x, y, z, w, l, rot });
  const clut = (kind, x, y, z, rot = 0, extra = {}) => P.clutter.push({ kind, x, y, z, rot, ...extra });
  const constructionRoads = new Set();
  while (constructionRoads.size < 12) constructionRoads.add(rng.int(0, L.roads.length - 1));
  L.roads.forEach((r, ri) => {
    const axisX = r.axis === 'x';
    const a = axisX ? r.a.x + r.a.halfX : r.a.z + r.a.halfZ;
    const b = axisX ? r.b.x - r.b.halfX : r.b.z - r.b.halfZ;
    const fixed = axisX ? r.a.z : r.a.x;
    const pos = (t, off) => (axisX ? [t, fixed + off] : [fixed + off, t]);
    const rot = axisX ? Math.PI / 2 : 0;
    const district = districtOf(axisX ? (a + b) / 2 : fixed, axisX ? fixed : (a + b) / 2);
    const offs = laneOffsets(r.line);
    // asphalt wear
    for (let k = 0; k < rng.int(1, 2); k++) { const [x, z] = pos(rng.float(a + 6, b - 6), rng.pick(offs) * rng.pick([-1, 1])); dec(DC.manhole, x, 0.022, z, 0.95, 0.95, rng.float(0, 6)); }
    for (let k = 0; k < rng.int(3, 7); k++) { const [x, z] = pos(rng.float(a + 3, b - 3), rng.pick(offs) * rng.pick([-1, 1]) + rng.float(-0.4, 0.4)); dec(DC.oil, x, 0.021, z, rng.float(0.9, 1.6), rng.float(1.4, 2.6), rot); }
    for (let k = 0; k < rng.int(1, 3); k++) { const [x, z] = pos(rng.float(a + 5, b - 5), rng.float(-r.half + 2, r.half - 2)); dec(DC.patch, x, 0.02, z, rng.float(1.6, 3.5), rng.float(2.5, 6), rot + rng.pick([0, Math.PI / 2])); }
    for (let k = 0; k < rng.int(2, 4); k++) { const [x, z] = pos(rng.float(a + 3, b - 3), rng.float(-r.half + 1, r.half - 1)); dec(DC.crack, x, 0.023, z, rng.float(1.5, 3), rng.float(3, 5), rot + rng.float(-0.6, 0.6)); }
    for (let k = 0; k < rng.int(0, 2); k++) { const [x, z] = pos(rng.float(a + 8, b - 8), 0); dec(DC.seam, x, 0.022, z, r.half * 2 - 0.4, 0.4, rot + Math.PI / 2); }
    // storm grates in the gutter near both ends, litter along the curb
    for (const s of [-1, 1]) {
      for (const t of [a + 3, b - 3]) { const [x, z] = pos(t, s * (r.half - 0.45)); dec(DC.grate, x, 0.024, z, 0.55, 1.1, rot); }
      for (let k = 0; k < rng.int(1, 4); k++) { const [x, z] = pos(rng.float(a + 2, b - 2), s * (r.half - rng.float(0.3, 0.9))); dec(rng.pick([DC.paper, DC.can, DC.leaves]), x, 0.025, z, rng.float(0.9, 1.6), rng.float(0.9, 1.6), rng.float(0, 6)); }
      // sidewalk stains, gum, utility covers
      for (let k = 0; k < rng.int(1, 3); k++) { const [x, z] = pos(rng.float(a + 2, b - 2), s * (r.half + rng.float(0.8, r.sw - 0.5))); dec(rng.pick([DC.stain, DC.gum, DC.gum]), x, curb + 0.012, z, rng.float(1, 2.2), rng.float(1, 2.2), rng.float(0, 6)); }
      if (rng.chance(0.5)) { const [x, z] = pos(rng.float(a + 4, b - 4), s * (r.half + 1.2)); dec(DC.utility, x, curb + 0.013, z, 0.7, 0.7, rot); }
    }
    // lane arrows before signalised stop lines
    if (r.arterial) {
      for (const dir of [1, -1]) {
        const end = dir > 0 ? b - 13 : a + 13;
        offs.forEach((off, k) => {
          const lateral = axisX ? dir * off : -dir * off; // right-hand lanes
          const [ax, az] = pos(end, lateral);
          const heading = axisX ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (dir > 0 ? 0 : Math.PI);
          const cell = k === 0 ? (rng.chance(0.5) ? DC.arrowL : DC.arrowS) : (rng.chance(0.5) ? DC.arrowR : DC.arrowS);
          dec(cell, ax, 0.026, az, 1.3, 3.6, heading);
        });
      }
    }
    // pavement clutter
    for (const s of [-1, 1]) {
      const sideOff = s * (r.half + 0.75);
      const wallOff = s * (r.half + r.sw - 0.5);
      if (district !== 'highway' && rng.chance(district === 'industrial' ? 0.6 : 0.55)) {
        const t = rng.float(a + 6, b - 6);
        const [x, z] = pos(t, rng.chance(0.5) ? sideOff : wallOff);
        clut('bags', x, curb, z, rng.float(0, 6), { n: rng.int(2, 5) });
        if (rng.chance(0.4)) { const [x2, z2] = pos(t + rng.float(1, 2), rng.chance(0.5) ? sideOff : wallOff); clut('boxes', x2, curb, z2, rng.float(0, 6)); }
      }
      if ((district === 'downtown' || district === 'commercial') && rng.chance(0.35)) {
        const t = rng.chance(0.5) ? a + 3 : b - 3;
        const n = rng.int(2, 4);
        for (let k = 0; k < n; k++) { const [x, z] = pos(t + (t < (a + b) / 2 ? k : -k) * 0.62, sideOff); clut('newsbox', x, curb, z, rot + (s > 0 ? Math.PI : 0) + Math.PI / 2, { color: rng.pick([0x35507a, 0x8a3a32, 0xa88a40, 0x3a5a46, 0x6b6f75]) }); }
      }
      if (district === 'downtown' && rng.chance(0.07)) { const [x, z] = pos(rng.float(a + 10, b - 10), sideOff + s * 0.6); clut('cart', x, curb, z, rot); }
      if ((district === 'downtown' || district === 'commercial') && rng.chance(0.12)) {
        const t = rng.float(a + 8, b - 12);
        for (let k = 0; k < rng.int(2, 4); k++) { const [x, z] = pos(t + k * 2.45, s * (r.half + 1.6)); clut('crowdbarrier', x, curb, z, rot); }
      }
    }
    // road works: plastic barriers enclosing part of the outer lane, cones, a striped steam stack
    if (constructionRoads.has(ri) && b - a > 50) {
      const s = rng.pick([-1, 1]);
      const t0 = rng.float(a + 10, b - 40), len = rng.float(16, 26);
      const outer = s * (r.half - 0.6), inner = s * (r.half - 3.2);
      const zone = { pts: [], axis: r.axis };
      for (let t = t0; t <= t0 + len; t += 2.0) { const [x, z] = pos(t, inner); clut('barrier', x, 0, z, rot, { color: Math.round((t - t0) / 2) % 2 }); zone.pts.push([x, z]); }
      for (const tt of [t0 - 0.2, t0 + len + 0.2]) for (let o = 0.5; o < 2.6; o += 1.0) { const [x, z] = pos(tt, inner + s * o); clut('barrier', x, 0, z, rot + Math.PI / 2, { color: Math.round(o) % 2 }); }
      for (let k = 1; k <= 4; k++) { const [x, z] = pos(t0 - k * 3.5, inner + s * (k * 0.5)); clut('cone', x, 0, z, 0); }
      const [sx, sz] = pos(t0 + len / 2, s * (r.half - 1.8));
      clut('steam', sx, 0, sz, 0);
      for (let k = 0; k < 3; k++) { const [x, z] = pos(t0 + rng.float(2, len - 2), s * (r.half - rng.float(1, 2.5))); clut('cone', x, 0, z, 0); }
      P.construction.push(zone);
    }
  });
  // no parked cars inside road works
  const zonePts = P.construction.flatMap((z) => z.pts);
  P.parkedCars = P.parkedCars.filter((c) => !zonePts.some(([x, z]) => (x - c.x) ** 2 + (z - c.z) ** 2 < 30));
  // industrial yards
  for (const B of L.blocks) {
    if (B.type !== 'warehouses' && B.type !== 'factory' && B.type !== 'parking') continue;
    const n = B.type === 'parking' ? 4 : 18;
    for (let k = 0; k < n; k++) {
      const x = rng.float(B.ix0 + 4, B.ix1 - 4), z = B.type === 'parking' ? (rng.chance(0.5) ? B.iz0 + 2 : B.iz1 - 2) : rng.float(B.iz1 - 22, B.iz1 - 4);
      const kind = rng.weighted([['pallets', 0.25], ['drums', 0.2], ['tires', 0.1], ['tarp', 0.15], ['boxes', 0.15], ['bricks', 0.1], ['bags', 0.05]]);
      clut(kind, x, curb, z, rng.float(0, 6), { n: rng.int(1, 4), color: rng.pick([0x2e4566, 0x1b1b1b, 0x6a2d27, 0x34503b]) });
    }
  }
}

// ---------- street furniture ----------
function planStreetProps(L, rng) {
  const P = L.props;
  const curb = CITY.curb;
  for (const r of L.roads) {
    const along = r.axis === 'x' ? [1, 0] : [0, 1];
    const side = r.axis === 'x' ? [0, 1] : [1, 0];
    const a = r.axis === 'x' ? r.a.x + r.a.halfX : r.a.z + r.a.halfZ;
    const b = r.axis === 'x' ? r.b.x - r.b.halfX : r.b.z - r.b.halfZ;
    const fixed = r.axis === 'x' ? r.a.z : r.a.x;
    const district = districtOf(r.axis === 'x' ? (a + b) / 2 : fixed, r.axis === 'x' ? fixed : (a + b) / 2);
    const lightGap = r.arterial ? 28 : 36;
    const pos = (t, off) => (r.axis === 'x' ? { x: t, z: fixed + off } : { x: fixed + off, z: t });
    for (const s of [-1, 1]) {
      if (!r.arterial && s === -1) continue;
      const off = s * (r.half + 0.6);
      for (let t = a + 8; t < b - 6; t += lightGap) {
        const p = pos(t, off);
        // arm points toward road center
        const rot = r.axis === 'x' ? (s > 0 ? Math.PI : 0) : (s > 0 ? -Math.PI / 2 : Math.PI / 2);
        P.streetlights.push({ x: p.x, z: p.z, rot, y: curb, kind: r.arterial ? 'double' : 'single' });
      }
    }
    // trees along sidewalks
    if (district !== 'industrial') {
      for (const s of [-1, 1]) {
        const off = s * (r.half + r.sw - 1.2);
        for (let t = a + 14; t < b - 10; t += rng.float(12, 18)) {
          if (rng.chance(district === 'downtown' ? 0.5 : 0.25)) continue;
          const p = pos(t, off);
          P.trees.push({ x: p.x, z: p.z, s: rng.float(0.65, 0.95), kind: district === 'downtown' ? 2 : rng.int(0, 2), y: curb, pit: true });
        }
      }
    }
    // benches, bins, meters, hydrants
    for (const s of [-1, 1]) {
      const off = s * (r.half + 1.1);
      const rot = r.axis === 'x' ? (s > 0 ? 0 : Math.PI) : (s > 0 ? Math.PI / 2 : -Math.PI / 2);
      if (rng.chance(0.6)) { const p = pos(rng.float(a + 10, b - 10), off); P.bins.push({ ...p, y: curb }); }
      if (rng.chance(0.45)) { const p = pos(rng.float(a + 10, b - 10), s * (r.half + 0.5)); P.hydrants.push({ ...p, y: curb }); }
      if (district === 'downtown' || district === 'commercial') {
        for (let t = a + 18; t < b - 18; t += 7) if (rng.chance(0.35)) { const p = pos(t, s * (r.half + 0.45)); P.meters.push({ ...p, y: curb, rot }); }
        if (rng.chance(0.4)) { const p = pos(rng.float(a + 15, b - 15), s * (r.half + r.sw - 1)); P.benches.push({ ...p, y: curb, rot: rot + Math.PI }); }
      }
      if (r.arterial && rng.chance(0.28)) {
        const p = pos(rng.float(a + 20, b - 20), s * (r.half + r.sw * 0.6));
        P.busStops.push({ ...p, y: curb, rot });
      }
      if ((district === 'residential' || district === 'industrial') && !r.arterial && s === 1) {
        for (let t = a + 6; t < b - 6; t += 30) { const p = pos(t, s * (r.half + r.sw - 0.4)); P.utilityPoles.push({ ...p, y: curb, axis: r.axis }); }
      }
    }
    // parked cars along side streets (parking lane)
    if (!r.arterial && (district === 'residential' || district === 'commercial')) {
      for (const s of [-1, 1]) {
        for (let t = a + 10; t < b - 10; t += 6.5) {
          if (!rng.chance(0.2)) continue;
          const p = pos(t, s * 4.4);
          // parked facing the travel direction for that side
          const heading = r.axis === 'x' ? (s > 0 ? Math.PI / 2 : -Math.PI / 2) : (s > 0 ? Math.PI : 0);
          P.parkedCars.push({ x: p.x, y: 0, z: p.z, rot: heading, variant: rng.int(0, 3), color: rng.next() });
        }
      }
      if (district === 'residential' && rng.chance(0.35)) {
        const p = pos((a + b) / 2, 0);
        P.speedBumps.push({ ...p, axis: r.axis, width: r.half * 2 });
      }
    }
  }

  // intersection furniture: signals, stop signs, crosswalks
  for (const I of L.intersections) {
    const approaches = [];
    for (const pid of I.incoming) {
      const p = L.paths[pid];
      if (p.lane !== 0) continue;
      approaches.push(p.dir);
    }
    for (const d of approaches) {
      const right = [-d[2], 0, d[0]];
      const cross = d[0] !== 0 ? I.halfX : I.halfZ;
      const own = d[0] !== 0 ? I.halfZ : I.halfX;
      // pole on the near-right corner of the approach
      const px = I.x - d[0] * (cross + 1.5) + right[0] * (own + 1.2);
      const pz = I.z - d[2] * (cross + 1.5) + right[2] * (own + 1.2);
      const heading = Math.atan2(-d[0], -d[2]); // face oncoming traffic
      if (I.type === 'signal') P.signals.push({ x: px, z: pz, rot: heading, inter: I.id, axis: d[0] !== 0 ? 'x' : 'z', arm: own + 1.2 - 1.75, y: curb });
      else P.stopSigns.push({ x: px, z: pz, rot: heading, y: curb });
      // crosswalk across the approach road just before the stop line
      const cwx = I.x - d[0] * (cross + 2.2), cwz = I.z - d[2] * (cross + 2.2);
      P.crosswalks.push({ x: cwx, z: cwz, axis: d[0] !== 0 ? 'x' : 'z', width: own * 2, inter: I.id });
    }
  }
}

function planHighwayProps(L, rng) {
  const P = L.props;
  const c = L.ring.center;
  const n = c.length;
  const T = TUNNEL;
  const inTunnel = (x, z) => Math.abs(z - T.z) < 30 && x > T.x0 - 2 && x < T.x1 + 2;
  const nearJunction = (x, z) =>
    (Math.abs(x) < 16 && Math.abs(Math.abs(z) - RING.offset) < 30) ||
    (Math.abs(z) < 16 && Math.abs(Math.abs(x) - RING.offset) < 30);
  // median & outer barriers as short segments
  for (let i = 0; i < n; i += 2) {
    const a = c[i], b = c[(i + 2) % n];
    const mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2;
    if (nearJunction(mx, mz)) continue;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const rot = Math.atan2(b[0] - a[0], b[2] - a[2]);
    P.barriers.push({ x: mx, z: mz, len, rot, kind: 'jersey' });
    const tx = (b[0] - a[0]) / len, tz = (b[2] - a[2]) / len;
    if (!inTunnel(mx, mz)) {
      for (const s of [-1, 1]) {
        const off = s * (RING.halfWidth + 0.5);
        P.barriers.push({ x: mx - tz * off, z: mz + tx * off, len, rot, kind: 'rail' });
      }
    }
    // highway lights every ~42m on the median
    if (i % 14 === 0 && !inTunnel(mx, mz)) P.streetlights.push({ x: mx, z: mz, rot, kind: 'highway', y: 0 });
  }
  // tunnel ceiling lamps
  for (let x = T.x0 + 6; x < T.x1; x += 12) {
    for (const s of [-1, 1]) P.tunnelLamps.push({ x, y: T.archH - 0.6, z: T.z + s * 6 });
  }
  // gantries before junctions
  const gantryAt = [
    { x: 520, z: -90, rot: 0, text: ['MERIDIAN CENTRE', 'EXIT 2  EASTGATE'] },
    { x: -520, z: 90, rot: Math.PI, text: ['WESTBROOK', 'EXIT 4  CITY'] },
    { x: 90, z: 520, rot: -Math.PI / 2, text: ['PORT INDUSTRIAL', 'EXIT 3'] },
    { x: -90, z: -520, rot: Math.PI / 2, text: ['NORTHGATE', 'TUNNEL 600 m'] },
  ];
  for (const g of gantryAt) P.gantries.push(g);
  // billboards along the expressway and in the highway district
  const brands = 0;
  for (let k = 0; k < 14; k++) {
    const side = rng.pick(['n', 's', 'e', 'w']);
    const t = rng.float(-380, 380);
    const off = RING.offset + RING.halfWidth + 14;
    const p = side === 'n' ? { x: t, z: -off, rot: 0 } : side === 's' ? { x: t, z: off, rot: Math.PI } : side === 'e' ? { x: off, z: t, rot: -Math.PI / 2 } : { x: -off, z: t, rot: Math.PI / 2 };
    if (inTunnel(p.x, p.z) || Math.abs(t) < 40) continue;
    P.billboards.push({ ...p, ad: (brands + k) % 6 });
  }
  for (let x = 680; x < 1100; x += 85) {
    P.billboards.push({ x, z: rng.chance(0.5) ? 26 : -26, rot: 0, ad: rng.int(0, 5) });
  }
  // boulevard lights and trees in the highway district
  for (let x = 420; x < BOULEVARD.endX; x += 32) {
    const y = boulevardY(x);
    for (const s of [-1, 1]) P.streetlights.push({ x, z: s * 8.2, y, rot: s > 0 ? Math.PI : 0, kind: 'single' });
  }
  for (let k = 0; k < 260; k++) {
    const x = rng.float(560, 1300), z = rng.float(-500, 500);
    if (Math.abs(z) < 34 || Math.hypot(x - ROUNDABOUT.x, z) < 50) continue;
    if (x < 600 && Math.abs(z) < 60) continue;
    P.trees.push({ x, z, s: rng.float(0.8, 1.5), kind: rng.int(0, 2) });
  }
  // trees in the green belt between city and ring
  for (let k = 0; k < 420; k++) {
    const a = rng.float(0, Math.PI * 2);
    const r = rng.float(430, 495);
    const x = Math.cos(a) * r * 1.0, z = Math.sin(a) * r;
    const sx = clamp(x, -495, 495), sz = clamp(z, -495, 495);
    if (Math.max(Math.abs(sx), Math.abs(sz)) < 425) continue;
    if (Math.abs(sx) < 22 || Math.abs(sz) < 22) continue; // keep connector roads clear
    P.trees.push({ x: sx, z: sz, s: rng.float(0.8, 1.4), kind: rng.int(0, 2) });
  }
  // roundabout island trees
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    P.trees.push({ x: ROUNDABOUT.x + Math.cos(a) * 11, z: ROUNDABOUT.z + Math.sin(a) * 11, s: 1.1, kind: 1, y: 0.3 });
  }
  // highway-district service parking lot near the roundabout
  for (let x = 1060; x < 1120; x += 3) {
    for (const z of [44, 52]) {
      P.stallLines.push({ x, z, rot: 0 });
      if (rng.chance(0.5)) P.parkedCars.push({ x: x + 1.5, y: 0, z: z + (z === 44 ? -2.6 : 2.6) * 0, rot: z === 44 ? Math.PI : 0, variant: rng.int(0, 3), color: rng.next() });
    }
  }
}

// ---------- surface raster (1 m cells) ----------
export const RASTER = { x0: -720, z0: -720, w: 2040, h: 1440, cell: 1 };

function buildRaster(L) {
  const R = RASTER;
  const data = new Uint8Array(R.w * R.h);
  const fillRect = (x0, z0, x1, z1, v) => {
    const a = Math.max(0, Math.floor(x0 - R.x0)), b = Math.min(R.w - 1, Math.ceil(x1 - R.x0));
    const c = Math.max(0, Math.floor(z0 - R.z0)), d = Math.min(R.h - 1, Math.ceil(z1 - R.z0));
    for (let z = c; z < d; z++) data.fill(v, z * R.w + a, z * R.w + b);
  };
  const fillDisc = (cx, cz, r0, r1, v) => {
    for (let z = Math.floor(cz - r1); z <= cz + r1; z++) {
      for (let x = Math.floor(cx - r1); x <= cx + r1; x++) {
        const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
        if (d < r0 || d > r1) continue;
        const ix = x - R.x0, iz = z - R.z0;
        if (ix >= 0 && iz >= 0 && ix < R.w && iz < R.h) data[iz * R.w + ix] = v;
      }
    }
  };
  const fillPolyline = (pts, half, v, closed) => {
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const minx = Math.min(a[0], b[0]) - half, maxx = Math.max(a[0], b[0]) + half;
      const minz = Math.min(a[2], b[2]) - half, maxz = Math.max(a[2], b[2]) + half;
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const l2 = dx * dx + dz * dz || 1;
      for (let z = Math.floor(minz); z <= maxz; z++) {
        for (let x = Math.floor(minx); x <= maxx; x++) {
          const px = x + 0.5, pz = z + 0.5;
          const t = clamp(((px - a[0]) * dx + (pz - a[2]) * dz) / l2, 0, 1);
          const d = Math.hypot(px - a[0] - dx * t, pz - a[2] - dz * t);
          if (d > half) continue;
          const ix = x - R.x0, iz = z - R.z0;
          if (ix >= 0 && iz >= 0 && ix < R.w && iz < R.h) data[iz * R.w + ix] = v;
        }
      }
    }
  };
  // blocks: sidewalk slab, then interior
  const interiorCode = { towers: SURF.SIDEWALK, plaza: SURF.SIDEWALK, park: SURF.PARK, midrise: SURF.SIDEWALK, houses: SURF.PARK, apartments: SURF.PARK, warehouses: SURF.YARD, factory: SURF.YARD, parking: SURF.PARKING };
  for (const B of L.blocks) {
    fillRect(B.x0, B.z0, B.x1, B.z1, SURF.SIDEWALK);
    fillRect(B.ix0, B.iz0, B.ix1, B.iz1, interiorCode[B.type]);
  }
  for (const b of L.buildings) {
    if (b.y0 > 0) continue;
    fillRect(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, SURF.BUILDING);
  }
  // grid roads
  for (let i = 0; i <= CITY.N; i++) {
    const g = gridLine(i), h = roadHalf(i);
    fillRect(g - h, -CITY.half - 8, g + h, CITY.half + 8, SURF.ROAD);
    fillRect(-CITY.half - 8, g - h, CITY.half + 8, g + h, SURF.ROAD);
  }
  // connectors to the ring (north, south, west) and the boulevard (east)
  fillRect(-7, -RING.offset, 7, -CITY.half, SURF.ROAD);
  fillRect(-7, CITY.half, 7, RING.offset, SURF.ROAD);
  fillRect(-RING.offset, -7, -CITY.half, 7, SURF.ROAD);
  fillRect(CITY.half, -7, BOULEVARD.endX + 2, 7, SURF.ROAD);
  fillPolyline(L.ring.center, RING.halfWidth, SURF.HIGHWAY, true);
  fillDisc(ROUNDABOUT.x, ROUNDABOUT.z, ROUNDABOUT.island, ROUNDABOUT.outer, SURF.ROAD);
  fillDisc(ROUNDABOUT.x, ROUNDABOUT.z, 0, ROUNDABOUT.island, SURF.PARK);
  fillRect(1050, 38, 1125, 58, SURF.PARKING);
  fillRect(1080, 7, 1092, 38, SURF.ROAD);
  return { ...R, data };
}

export function surfaceAt(raster, x, z) {
  const ix = Math.floor(x - raster.x0), iz = Math.floor(z - raster.z0);
  if (ix < 0 || iz < 0 || ix >= raster.w || iz >= raster.h) return SURF.GROUND;
  return raster.data[iz * raster.w + ix];
}

/** Traffic-light state for an approach axis ('x' or 'z') at simulation time t. */
export function signalState(I, axis, t) {
  if (!I || I.type !== 'signal') return 'go';
  const half = I.green + 3 + 1.5;
  const p = (((t + I.offset) % I.cycle) + I.cycle) % I.cycle;
  const active = p < half ? 'x' : 'z';
  if (axis !== active) return 'red';
  const q = p % half;
  return q < I.green ? 'green' : q < I.green + 3 ? 'yellow' : 'red';
}

/** Nearest point on any drivable path, used for vehicle reset. Returns {x,y,z,heading}. */
export function nearestLanePoint(L, x, z) {
  let best = null, bd = Infinity;
  for (const p of L.paths) {
    if (p.kind === 'connector') continue;
    for (let i = 0; i < p.pts.length - 1; i++) {
      const a = p.pts[i], b = p.pts[i + 1];
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const l2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - a[0]) * dx + (z - a[2]) * dz) / l2, 0, 1);
      const px = a[0] + dx * t, pz = a[2] + dz * t;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bd) { bd = d; best = { x: px, y: a[1] + (b[1] - a[1]) * t, z: pz, heading: Math.atan2(dx, dz) }; }
    }
  }
  return best;
}
