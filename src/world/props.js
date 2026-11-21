// Geometry factories for street furniture. Each returns { materialKey: BufferGeometry } with the
// origin at ground level and the "front" facing +Z. Instanced by the city builder.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const ni = (g) => (g.index ? g.toNonIndexed() : g);
const merge = (list) => mergeGeometries(list.map(ni));
function box(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
function cyl(rt, rb, h, x = 0, y = 0, z = 0, seg = 10, axis = 'y') {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

export function streetlightGeo(kind) {
  const highway = kind === 'highway';
  const lot = kind === 'lot';
  const h = highway ? 12 : kind === 'single' ? 7.5 : 9;
  const reach = highway ? 3.2 : kind === 'double' ? 2.2 : 1.6;
  const metal = [
    cyl(0.062, highway ? 0.15 : 0.107, h - 0.72, 0, (h - 0.72) / 2, 0, 8),
    cyl(0.14, 0.17, 0.32, 0, 0.16, 0, 8),
    box(0.17, 0.22, 0.11, 0, 0.64, -0.055),
  ];
  const housing = [], lenses = [], lampOffsets = [];
  const directions = highway || kind === 'double' || lot ? [-1, 1] : [1];
  for (const side of directions) {
    const x = lot ? side * 0.76 : 0;
    const z = lot ? 0 : side * reach;
    const y = h - 0.19;
    const arm = new THREE.CubicBezierCurve3(
      new THREE.Vector3(0, h - 0.78, 0),
      new THREE.Vector3(0, h + 0.12, 0),
      new THREE.Vector3(x * 0.48, y, z * 0.52),
      new THREE.Vector3(x, y, z),
    );
    metal.push(new THREE.TubeGeometry(arm, 7, 0.049, 6, false));
    const length = highway ? 0.52 : 0.39;
    housing.push(new THREE.SphereGeometry(1, 8, 5).scale(0.18, 0.105, length).translate(x, y, z));
    lenses.push(new THREE.SphereGeometry(1, 8, 4).scale(0.137, 0.042, length * 0.77).translate(x, y - 0.088, z));
    lampOffsets.push([x, y - 0.14, z]);
  }
  return { metalPole: merge(metal), lampHead: merge(housing), streetLens: merge(lenses), lampOffsets };
}

export function signalGeo(armLen) {
  const L = Math.max(2, armLen);
  const pole = [cyl(0.1, 0.13, 6.2, 0, 3.1, 0, 10), box(0.1, 0.1, L, 0, 6.0, L / 2)];
  const head = [box(0.38, 1.05, 0.3, 0, 5.4, L - 0.6), box(0.26, 0.75, 0.22, -0.25, 2.8, 0.18)];
  return { metalPole: merge(pole), signalBox: merge(head) };
}
/** Lamp positions (red, yellow, green) relative to a signal for the overhead and the pole head. */
export function signalLampOffsets(armLen) {
  const L = Math.max(2, armLen);
  return [
    [[0, 5.72, L - 0.6 + 0.16], [0, 5.4, L - 0.6 + 0.16], [0, 5.08, L - 0.6 + 0.16]],
    [[-0.25, 3.03, 0.3], [-0.25, 2.8, 0.3], [-0.25, 2.57, 0.3]],
  ];
}
export function signalLampGeo() {
  const g = new THREE.CircleGeometry(0.12, 16);
  return g;
}

export function stopSignGeo() {
  const plate = new THREE.CircleGeometry(0.38, 8);
  plate.rotateZ(Math.PI / 8);
  plate.translate(0, 2.3, 0.04);
  return { galv: merge([cyl(0.035, 0.035, 2.3, 0, 1.15, 0, 8)]), stopFace: plate };
}

export function benchGeo() {
  const wood = [box(1.8, 0.05, 0.42, 0, 0.45, 0)];
  for (let i = 0; i < 3; i++) wood.push(box(1.8, 0.08, 0.025, 0, 0.6 + i * 0.12, -0.22, -0.15));
  const metal = [box(0.06, 0.45, 0.4, 0.75, 0.22, 0), box(0.06, 0.45, 0.4, -0.75, 0.22, 0), box(0.05, 0.4, 0.05, 0.75, 0.68, -0.22), box(0.05, 0.4, 0.05, -0.75, 0.68, -0.22)];
  return { wood: merge(wood), darkMetal: merge(metal) };
}
export function binGeo() { return { bin: merge([cyl(0.28, 0.25, 0.95, 0, 0.475, 0, 14), cyl(0.3, 0.3, 0.06, 0, 0.98, 0, 14)]) }; }
export function hydrantGeo() { return { hydrant: merge([cyl(0.12, 0.14, 0.6, 0, 0.3, 0, 12), new THREE.SphereGeometry(0.12, 10, 6).translate(0, 0.62, 0), cyl(0.05, 0.05, 0.36, 0, 0.42, 0, 8, 'x')]) }; }
export function meterGeo() { return { darkMetal: merge([cyl(0.035, 0.035, 1.1, 0, 0.55, 0, 8), box(0.18, 0.3, 0.14, 0, 1.25, 0)]) }; }
export function busStopGeo() {
  const frame = [box(4, 0.08, 1.7, 0, 2.6, -0.2)];
  for (const x of [-1.95, 1.95]) frame.push(box(0.08, 2.6, 0.08, x, 1.3, -1.0), box(0.08, 2.6, 0.08, x, 1.3, 0.6));
  frame.push(box(3.6, 0.06, 0.4, 0, 0.5, -0.8));
  return { darkMetal: merge(frame), shelterGlass: merge([box(3.8, 2.2, 0.02, 0, 1.4, -1.0), box(0.02, 2.2, 1.4, -1.95, 1.4, -0.25)]) };
}
export function utilityPoleGeo() {
  return { woodDark: merge([cyl(0.13, 0.16, 10, 0, 5, 0, 8), box(2.2, 0.12, 0.12, 0, 9.4, 0)]), darkMetal: merge([cyl(0.12, 0.12, 0.5, 0.6, 8.9, 0, 8)]) };
}
export function containerGeo() {
  const g = [box(6.06, 2.59, 2.44, 0, 1.295, 0)];
  return { container: merge(g) };
}
export function jerseyGeo() {
  // unit length along Z (scaled per instance)
  const s = new THREE.Shape();
  s.moveTo(-0.3, 0); s.lineTo(0.3, 0); s.lineTo(0.3, 0.08); s.lineTo(0.12, 0.33); s.lineTo(0.1, 0.81); s.lineTo(-0.1, 0.81); s.lineTo(-0.12, 0.33); s.lineTo(-0.3, 0.08); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  return { jersey: g };
}
export function railGeo() {
  return { galv: merge([box(0.05, 0.32, 1, 0, 0.62, 0), box(0.1, 0.72, 0.1, 0, 0.36, 0)]) };
}
export function speedBumpGeo() {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 16, 1, false, -Math.PI / 2, Math.PI);
  g.rotateZ(Math.PI / 2);
  g.scale(1, 0.18, 1);
  return { bump: g };
}

export function treeGeo(kind) {
  // kind 0: broad deciduous, 1: round, 2: narrow street tree
  const h = kind === 2 ? 4.2 : kind === 1 ? 3.0 : 3.6;
  const trunk = [cyl(0.13, 0.22, h + 1.4, 0, (h + 1.4) / 2, 0, 7)];
  for (let i = 0; i < 3; i++) {
    const b = cyl(0.05, 0.09, 2.2, 0, 0, 0, 5);
    b.translate(0, 1.1, 0);
    b.rotateZ(0.7); b.rotateY((i / 3) * Math.PI * 2 + 0.4);
    b.translate(0, h - 0.2, 0);
    trunk.push(b);
  }
  const cards = [];
  const fill = [];
  const rx = kind === 2 ? 1.5 : kind === 1 ? 2.7 : 3.1;
  const ry = kind === 2 ? 2.8 : kind === 1 ? 2.4 : 2.3;
  const cy = h + ry * 0.75;
  let seed = 11 + kind * 97;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const nCards = kind === 2 ? 22 : 34;
  for (let i = 0; i < nCards; i++) {
    const p = new THREE.PlaneGeometry(2.2, 2.2);
    p.rotateY(rnd() * Math.PI);
    p.rotateX((rnd() - 0.5) * 1.2);
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.8;
    const yy = (rnd() * 2 - 1) * 0.8;
    p.translate(Math.cos(a) * r * rx * 0.75, cy + yy * ry * 0.75, Math.sin(a) * r * rx * 0.75);
    // normals pointing outward from canopy centre give soft, volumetric lighting
    const pos = p.attributes.position, nrm = p.attributes.normal;
    for (let k = 0; k < pos.count; k++) {
      const v = new THREE.Vector3(pos.getX(k), pos.getY(k) - cy, pos.getZ(k)).normalize();
      nrm.setXYZ(k, v.x, v.y * 0.8 + 0.2, v.z);
    }
    cards.push(p);
  }
  const blob = new THREE.IcosahedronGeometry(1, 1);
  blob.scale(rx * 0.62, ry * 0.62, rx * 0.62);
  blob.translate(0, cy, 0);
  fill.push(blob);
  return { bark: merge(trunk), leaves: merge(cards), leavesFill: merge(fill), height: cy + ry };
}

export function grassClumpGeo() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.PlaneGeometry(0.9, 0.5);
    p.translate(0, 0.25, 0);
    p.rotateY((i / 3) * Math.PI);
    const n = p.attributes.normal;
    for (let k = 0; k < n.count; k++) n.setXYZ(k, 0, 1, 0);
    parts.push(p);
  }
  return { grassBlades: merge(parts) };
}

export function billboardGeo() {
  const frame = [cyl(0.25, 0.3, 9, -3.5, 4.5, -0.3, 10), cyl(0.25, 0.3, 9, 3.5, 4.5, -0.3, 10), box(10.4, 0.2, 0.6, 0, 7.2, 0.1), box(10.4, 4.2, 0.25, 0, 11.3, -0.18)];
  const face = new THREE.PlaneGeometry(10, 3.9);
  face.translate(0, 11.3, -0.04);
  return { darkMetal: merge(frame), face };
}

export function gantryGeo(span) {
  const parts = [box(0.5, 8, 0.5, -span / 2, 4, 0), box(0.5, 8, 0.5, span / 2, 4, 0), box(span + 1, 0.5, 0.5, 0, 7.6, 0), box(span + 1, 0.3, 0.3, 0, 6.6, 0)];
  const face = new THREE.PlaneGeometry(9, 2.3);
  face.translate(span * 0.18, 6.9, 0.3);
  return { galv: merge(parts), face };
}

// ---------------------------------------------------------------------------
// Prewar street set
// ---------------------------------------------------------------------------
let _seed = 1;
const rnd = () => ((_seed = (_seed * 16807) % 2147483647) / 2147483647);
function lumpy(g, amt, seed) {
  _seed = seed;
  const p = g.attributes.position;
  const cache = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!cache.has(k)) cache.set(k, 1 + (rnd() - 0.5) * amt);
    const f = cache.get(k);
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * (0.9 + (f - 1) * 0.5 + 0.1), p.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
}

/** One floor of a fire escape: landing, railing, balusters and the stair to the landing below.
 *  Origin at the wall face, floor level; extends along +X (width) and +Z (out from the wall). */
export function fireEscapeGeo(width = 3.4, floorH = 3.1) {
  // Low-poly: railings are alpha-tested planes (bars come from a texture) instead of ~60 baluster boxes.
  const d = 1.15, iron = [], rail = [];
  iron.push(box(width, 0.05, d, width / 2, 0, d / 2));                     // landing
  iron.push(box(width, 0.05, 0.05, width / 2, 0.95, d));                   // top rail
  for (const x of [0, width]) iron.push(box(0.05, 0.05, d, x, 0.95, d / 2));
  const front = new THREE.PlaneGeometry(width, 0.95); front.translate(width / 2, 0.475, d);
  const sideA = new THREE.PlaneGeometry(d, 0.95); sideA.rotateY(Math.PI / 2); sideA.translate(0, 0.475, d / 2);
  const sideB = sideA.clone(); sideB.translate(width, 0, 0);
  rail.push(front, sideA, sideB);
  const run = width * 0.72, sx0 = width * 0.14;
  const len = Math.hypot(run, floorH), ang = Math.atan2(floorH, run);
  for (const z of [0.15, 0.75]) {
    const st = box(len, 0.06, 0.04, 0, 0, 0);
    st.rotateZ(-ang);
    st.translate(sx0 + run / 2, -floorH / 2, z);
    iron.push(st);
  }
  for (let k = 1; k < 7; k++) iron.push(box(0.22, 0.03, 0.6, sx0 + (run * k) / 7, -floorH + (floorH * (7 - k)) / 7, 0.45));
  return { iron: merge(iron), railing: merge(rail) };
}

export function waterTankGeo() {
  const legs = [];
  for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) legs.push(box(0.16, 3.2, 0.16, x, 1.6, z));
  legs.push(box(3.2, 0.12, 3.2, 0, 3.2, 0));
  const barrel = cyl(1.75, 1.85, 3.6, 0, 5.05, 0, 12);
  const bands = [];
  for (const y of [3.8, 5.0, 6.2]) bands.push(new THREE.CylinderGeometry(1.84, 1.84, 0.07, 12, 1, true).translate(0, y, 0));
  const roof = new THREE.ConeGeometry(1.95, 1.3, 12); roof.translate(0, 7.5, 0);
  return { iron: merge([...legs, ...bands, roof]), tankWood: barrel };
}

/** Awning for one 4.2 m storefront bay: sloped fabric plus valance. Front faces +Z. */
export function awningGeo() {
  const w = 3.6, depth = 1.25, drop = 0.55;
  const top = new THREE.PlaneGeometry(w, Math.hypot(depth, drop));
  top.rotateX(-Math.PI / 2 + Math.atan2(drop, depth));
  top.translate(0, -drop / 2, depth / 2);
  const val = new THREE.PlaneGeometry(w, 0.36); val.translate(0, -drop - 0.18, depth);
  const sides = [];
  for (const x of [-w / 2, w / 2]) {
    const s = new THREE.BufferGeometry();
    s.setAttribute('position', new THREE.Float32BufferAttribute([x, 0, 0, x, -drop, depth, x, -drop - 0.36, depth, x, 0, 0, x, -drop - 0.36, depth, x, -0.36, 0], 3));
    s.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
    s.computeVertexNormals();
    sides.push(s);
  }
  return { awning: merge([top, val, ...sides]) };
}
export function awningSignGeo(row) {
  const g = new THREE.PlaneGeometry(3.2, 0.3);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.12 + uv.getX(i) * 0.76, 1 - (row + 1) / 8 + uv.getY(i) / 8);
  g.translate(0, -0.55 - 0.18, 1.255);
  return g;
}

export function trashBagsGeo(n = 4, seed = 3) {
  _seed = seed;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const r = 0.32 + rnd() * 0.18;
    const g = lumpy(new THREE.IcosahedronGeometry(r, 1), 0.35, seed * 13 + i);
    g.scale(1, 0.8, 1);
    g.translate((rnd() - 0.5) * 1.2, r * 0.75 + (i > 2 ? 0.35 : 0), (rnd() - 0.5) * 0.9);
    parts.push(g);
  }
  return { trashBag: merge(parts) };
}

export function boxesGeo(seed = 5) {
  _seed = seed;
  const parts = [];
  let y = 0;
  for (let i = 0; i < 3 + Math.floor(rnd() * 3); i++) {
    const w = 0.4 + rnd() * 0.4, h = 0.3 + rnd() * 0.35, d = 0.35 + rnd() * 0.35;
    const stackOn = i > 0 && rnd() < 0.55;
    if (!stackOn) y = 0;
    parts.push(box(w, h, d, (rnd() - 0.5) * 1.1, y + h / 2, (rnd() - 0.5) * 0.8, 0, rnd() * 0.8));
    y += h;
  }
  return { cardboard: merge(parts) };
}

export function newsBoxGeo() {
  return { newsBox: merge([box(0.48, 0.75, 0.42, 0, 0.62, 0), box(0.5, 0.12, 0.44, 0, 1.04, 0, -0.15)]), iron: merge([box(0.4, 0.25, 0.04, 0, 0.12, 0.18), box(0.4, 0.25, 0.04, 0, 0.12, -0.18)]) };
}

export function cartGeo() {
  const body = [box(1.9, 0.9, 0.85, 0, 0.75, 0), box(2.0, 0.06, 0.95, 0, 1.22, 0)];
  const wheels = [];
  for (const x of [-0.7, 0.7]) wheels.push(cyl(0.28, 0.28, 0.06, x, 0.28, 0.46, 14, 'z'), cyl(0.28, 0.28, 0.06, x, 0.28, -0.46, 14, 'z'));
  const pole = cyl(0.025, 0.025, 1.4, 0, 1.9, 0, 6);
  const umb = new THREE.ConeGeometry(1.25, 0.5, 12, 1, true); umb.translate(0, 2.7, 0);
  return { galv: merge(body), rubber: merge(wheels), iron: pole, umbrella: umb };
}

export function crowdBarrierGeo() {
  const parts = [box(2.3, 0.04, 0.04, 0, 1.05, 0), box(2.3, 0.04, 0.04, 0, 0.18, 0)];
  for (const x of [-1.15, 1.15]) parts.push(box(0.045, 1.05, 0.045, x, 0.55, 0));
  for (let x = -1.0; x <= 1.0; x += 0.14) parts.push(box(0.02, 0.86, 0.02, x, 0.61, 0));
  for (const x of [-1.0, 1.0]) parts.push(box(0.04, 0.04, 0.7, x, 0.02, 0));
  return { galv: merge(parts) };
}

/** Plastic water-filled road barrier, 1.8 m long along X. */
export function plasticBarrierGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.27, 0); s.lineTo(0.27, 0); s.lineTo(0.27, 0.12); s.lineTo(0.13, 0.45); s.lineTo(0.11, 0.98); s.lineTo(-0.11, 0.98); s.lineTo(-0.13, 0.45); s.lineTo(-0.27, 0.12); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1.8, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 2 });
  g.translate(0, 0, -0.9);
  g.rotateY(Math.PI / 2);
  return { whitePlastic: g };
}

export function coneGeo() {
  const c = new THREE.CylinderGeometry(0.035, 0.17, 0.7, 14, 1, true); c.translate(0, 0.39, 0);
  const band = new THREE.CylinderGeometry(0.09, 0.12, 0.13, 14, 1, true); band.scale(1.04, 1, 1.04); band.translate(0, 0.45, 0);
  return { orange: c, whitePlastic: band, rubber: box(0.42, 0.04, 0.42, 0, 0.02, 0) };
}

export function steamStackGeo() {
  const tube = cyl(0.36, 0.38, 2.6, 0, 1.3, 0, 18);
  const uv = tube.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 2.4);
  return { stripe: tube, rubber: cyl(0.4, 0.4, 0.06, 0, 2.6, 0, 18) };
}

export function palletsGeo(n = 3) {
  const parts = [];
  for (let k = 0; k < n; k++) {
    const y = k * 0.15;
    for (let i = 0; i < 7; i++) parts.push(box(0.1, 0.022, 1.0, -0.54 + i * 0.18, y + 0.135, 0));
    for (const z of [-0.45, 0, 0.45]) parts.push(box(1.2, 0.1, 0.1, 0, y + 0.07, z));
  }
  return { pallet: merge(parts) };
}

export function drumsGeo(n = 3) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    parts.push(cyl(0.29, 0.29, 0.88, Math.cos(a) * 0.36 * (n > 1), 0.44, Math.sin(a) * 0.36 * (n > 1), 16));
    for (const y of [0.3, 0.6]) { const t = new THREE.TorusGeometry(0.295, 0.015, 4, 16); t.rotateX(Math.PI / 2); t.translate(Math.cos(a) * 0.36 * (n > 1), y, Math.sin(a) * 0.36 * (n > 1)); parts.push(t); }
  }
  return { drum: merge(parts) };
}

export function tiresGeo(n = 3) {
  const parts = [];
  for (let i = 0; i < n; i++) { const t = new THREE.TorusGeometry(0.32, 0.13, 8, 18); t.rotateX(Math.PI / 2); t.translate(0, 0.13 + i * 0.25, 0); parts.push(t); }
  return { rubber: merge(parts) };
}

export function tarpGeo(seed = 9) {
  const g = new THREE.BoxGeometry(2.2, 1.1, 1.6, 6, 3, 5);
  const p = g.attributes.position;
  _seed = seed;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const sag = y > 0.4 ? -0.15 * Math.sin(p.getX(i) * 2.1 + seed) * Math.cos(p.getZ(i) * 2.7) : 0;
    const flare = y < -0.4 ? 1.12 : 1;
    p.setXYZ(i, p.getX(i) * flare + (rnd() - 0.5) * 0.05, y + sag, p.getZ(i) * flare + (rnd() - 0.5) * 0.05);
  }
  g.translate(0, 0.55, 0);
  g.computeVertexNormals();
  return { tarp: g };
}

export function bricksGeo() {
  return { ...palletsGeo(1), brickStack: box(1.05, 0.75, 0.9, 0, 0.53, 0) };
}

export function treeGuardGeo() {
  const soil = new THREE.PlaneGeometry(1.5, 1.5); soil.rotateX(-Math.PI / 2); soil.translate(0, 0.012, 0);
  const s = 0.72, iron = [], rail = [];
  for (const [x, z] of [[s, s], [-s, s], [s, -s], [-s, -s]]) iron.push(box(0.03, 0.46, 0.03, x, 0.23, z));
  for (const [x, z, ry] of [[0, s, 0], [0, -s, 0], [s, 0, Math.PI / 2], [-s, 0, Math.PI / 2]]) {
    const r = box(1.44, 0.03, 0.03, 0, 0.45, 0); r.rotateY(ry); r.translate(x, 0, z); iron.push(r);
    const p = new THREE.PlaneGeometry(1.44, 0.42); p.rotateY(ry); p.translate(x, 0.22, z); rail.push(p);
  }
  return { soil, iron: merge(iron), railing: merge(rail) };
}

/** Branching street tree: tapered recursive branches with sparse leaf cards at the tips. */
export function branchyTreeGeo(kind = 0, seed = 1) {
  _seed = 991 + kind * 37 + seed * 7;
  const wood = [], leaves = [];
  const trunkH = kind === 2 ? 2.6 : 2.2 + rnd() * 0.6;
  const up = new THREE.Vector3(0, 1, 0);
  const grow = (base, dir, len, rad, depth) => {
    const end = base.clone().addScaledVector(dir, len);
    const g = new THREE.CylinderGeometry(rad * 0.68, rad, len, depth > 2 ? 6 : depth > 1 ? 4 : 3, 1, true);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    g.translate(base.x, base.y, base.z);
    wood.push(g);
    if (depth <= 1 || rad < 0.03) {
      const n = depth === 0 ? (kind === 1 ? 3 : 2) : 1;
      for (let i = 0; i < n; i++) {
        const c = new THREE.PlaneGeometry(2.0 + rnd() * 0.8, 2.0 + rnd() * 0.8);
        c.rotateY(rnd() * Math.PI); c.rotateX((rnd() - 0.5) * 1.4);
        c.translate(end.x + (rnd() - 0.5) * 0.8, end.y + (rnd() - 0.3) * 0.6, end.z + (rnd() - 0.5) * 0.8);
        const nrm = c.attributes.normal, pos = c.attributes.position;
        for (let k = 0; k < pos.count; k++) { const v = new THREE.Vector3(pos.getX(k), pos.getY(k) - trunkH - 2.5, pos.getZ(k)).normalize(); nrm.setXYZ(k, v.x, v.y * 0.7 + 0.3, v.z); }
        leaves.push(c);
      }
      if (depth === 0 || rad < 0.03) return;
    }
    const kids = depth >= 3 ? 3 : 2 + (rnd() < 0.5 ? 1 : 0);
    for (let i = 0; i < kids; i++) {
      const spread = kind === 2 ? 0.28 : kind === 1 ? 0.5 : 0.42;
      const az = (i / kids) * Math.PI * 2 + rnd() * 1.2;
      const nd = dir.clone().add(new THREE.Vector3(Math.cos(az) * spread, 0.45 + rnd() * 0.35, Math.sin(az) * spread)).normalize();
      grow(end, nd, len * (0.82 + rnd() * 0.18), rad * 0.6, depth - 1);
    }
  };
  grow(new THREE.Vector3(0, 0, 0), new THREE.Vector3((rnd() - 0.5) * 0.08, 1, (rnd() - 0.5) * 0.08).normalize(), trunkH, kind === 2 ? 0.12 : 0.17, 3);
  return { bark: merge(wood), leaves: merge(leaves), height: trunkH + 6 };
}
