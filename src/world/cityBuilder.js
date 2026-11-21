// Turns the layout data into renderable meshes (instanced/merged, chunk-culled) and static colliders.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as PR from './props.js';
import { InstanceBatches, StripBins, MergeBins, CullRegistry, applyWorldUV, trs } from './batching.js';
import {
  CITY, RING, BOULEVARD, ROUNDABOUT, TUNNEL, SURF, gridLine, roadHalf, isArterial, laneOffsets, boulevardY, offsetPolyline,
} from './layout.js';
import { makeBillboard, makeSignTex } from '../render/textures.js';
import { BUILDING_STYLES, STYLE_TINTS } from '../render/buildingMaterial.js';
import { GROUPS } from '../core/physicsGroups.js';
import { mulberry32 } from '../core/rng.js';

const PALETTES = {
  glass: [[0.9, 0.95, 1.0], [0.8, 0.9, 0.95], [0.95, 0.95, 0.95], [0.75, 0.85, 0.9]],
  office: [[1, 1, 1], [0.92, 0.9, 0.86], [0.85, 0.85, 0.85], [1.05, 1.0, 0.92], [0.75, 0.74, 0.72]],
  shop: [[1, 0.93, 0.82], [0.92, 0.8, 0.7], [0.82, 0.86, 0.88], [1, 1, 0.95], [0.86, 0.7, 0.6], [0.7, 0.75, 0.68]],
  brick: [[1, 1, 1], [0.85, 0.8, 0.78], [1.1, 1.0, 0.95], [0.7, 0.66, 0.66]],
  house: [[1, 0.98, 0.92], [0.85, 0.9, 0.95], [0.95, 0.88, 0.75], [0.8, 0.85, 0.78], [0.98, 0.86, 0.82], [0.7, 0.72, 0.75]],
  warehouse: [[1, 1, 1], [0.85, 0.88, 0.92], [0.95, 0.9, 0.8], [0.75, 0.8, 0.85]],
  roofunit: [[1, 1, 1], [0.85, 0.85, 0.85]],
  stack: [[1, 1, 1], [0.9, 0.85, 0.8]],
  tank: [[1, 1, 1], [0.95, 0.95, 0.9]],
};

function gableGeo() {
  // unit prism: x in [-0.5,0.5], z in [-0.5,0.5], ridge along x at y=1
  const v = [
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0,
    -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, 0.5, 0, 0.5,
    -0.5, 0, -0.5, -0.5, 1, 0, -0.5, 0, 0.5,
    0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  const uv = [];
  for (let i = 0; i < v.length; i += 3) uv.push(v[i] * 3 + v[i + 2] * 3, v[i + 1] * 3);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

export function buildCity({ scene, layout: L, M, RAPIER, world }) {
  const cull = new CullRegistry();
  const IB = new InstanceBatches(scene, cull);
  const grassBatches = new InstanceBatches(scene, cull, 80);
  const SB = new StripBins(scene, cull);
  const MB = new MergeBins(scene, cull);
  const rnd = mulberry32(4242);
  const lamps = [];
  const quatY = (a) => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });
  // Static colliders are streamed: only those near the player stay enabled (see updateStreaming).
  const statics = [];
  const registerStatic = (c, x, z, r) => { const st = { c, x, z, r, on: true, dead: false }; statics.push(st); c.__st = st; return c; };
  /** Permanently remove a static collider (a prop or parked car that has become a dynamic body). */
  const retire = (c) => { if (c.__st) c.__st.dead = true; world.removeCollider(c, true); };
  const cuboid = (hx, hy, hz, x, y, z, rotY = 0, friction = 0.7) => {
    const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(friction);
    if (rotY) d.setRotation(quatY(rotY));
    const c = world.createCollider(d);
    return Math.max(hx, hz) < 300 ? registerStatic(c, x, z, Math.hypot(hx, hz)) : c;
  };
  const cylinder = (r, h, x, y, z) => registerStatic(world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, r).setTranslation(x, y + h / 2, z).setFriction(0.6)), x, z, r);
  const updateStreaming = (pos, radius = 200) => {
    let changed = 0;
    for (const st of statics) {
      if (st.dead) continue;
      const want = Math.hypot(st.x - pos.x, st.z - pos.z) - st.r < radius;
      if (want !== st.on) { st.c.setEnabled(want); st.on = want; changed++; }
    }
    return changed;
  };

  // ---------------- breakable street furniture ----------------
  // Each prop is a static collider until the player is about to hit it faster than its break speed;
  // then breakProp() swaps it for a dynamic rigid body with a visual proxy (see game.predictHits).
  const breakables = [];
  const propOwner = new Map();
  const debris = [];
  const makeBreakable = (kind, parts, handles, x, y, z, rot, shape, mass, breakSpeed, extra = {}) => {
    const d = RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz).setTranslation(x, y + shape.cy, z).setRotation(quatY(rot))
      .setFriction(0.5).setCollisionGroups(GROUPS.prop);
    const c = registerStatic(world.createCollider(d), x, z, Math.max(shape.hx, shape.hz) + 0.5);
    const rec = { kind, parts, handles, x, y, z, rot, shape, mass, breakSpeed, collider: c, broken: false, ...extra };
    breakables.push(rec);
    propOwner.set(c.handle, rec);
    return rec;
  };
  const breakProp = (rec) => {
    if (rec.broken) return null;
    rec.broken = true;
    retire(rec.collider);
    for (const h of rec.handles) IB.hide(h);
    if (rec.lamps) for (const lp of rec.lamps) lp.broken = true;
    if (rec.signalIdx) {
      for (const i of rec.signalIdx) signalLamps.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
      signalLamps.instanceMatrix.needsUpdate = true;
    }
    const q = quatY(rec.rot), sh = rec.shape;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(rec.x, rec.y, rec.z).setRotation(q)
      .setCcdEnabled(true).setLinearDamping(0.12).setAngularDamping(0.35));
    world.createCollider(RAPIER.ColliderDesc.cuboid(sh.hx, sh.hy, sh.hz).setTranslation(0, sh.cy, 0).setMass(rec.mass)
      .setFriction(0.65).setRestitution(0.12).setCollisionGroups(GROUPS.debris), body);
    const g = new THREE.Group();
    for (const [mk, geo] of Object.entries(rec.parts)) {
      const mat = MX[mk];
      if (!geo?.isBufferGeometry || !mat) continue;
      let m = mat;
      if (rec.color) { m = mat.clone(); m.color = mat.color.clone().multiply(rec.color); }
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = true; mesh.receiveShadow = true;
      g.add(mesh);
    }
    scene.add(g);
    debris.push({ body, mesh: g, t: 0 });
    while (debris.length > 120) removeDebris(debris.shift());
    return body;
  };
  const removeDebris = (d) => { scene.remove(d.mesh); world.removeRigidBody(d.body); };
  const updateDebris = (dt, playerPos) => {
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      const t = d.body.translation(), r = d.body.rotation();
      d.mesh.position.set(t.x, t.y, t.z);
      d.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      d.t += dt;
      const far = Math.hypot(t.x - playerPos.x, t.z - playerPos.z) > 180;
      if ((d.t > 120 && far) || t.y < -30) { removeDebris(d); debris.splice(i, 1); }
    }
  };

  // ---------------- ground ----------------
  cuboid(4000, 1, 4000, 0, -1, 0, 0, 0.9);
  {
    const g = new THREE.PlaneGeometry(9000, 9000, 1, 1);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 9000 / 7, uv.getY(i) * 9000 / 7);
    const ground = new THREE.Mesh(g, M.grass);
    ground.receiveShadow = true;
    ground.position.y = -0.005;
    ground.matrixAutoUpdate = false; ground.updateMatrix();
    scene.add(ground);
  }

  // ---------------- blocks: raised sidewalk slab with curbs and interior surface ----------------
  const interiorMat = { park: M.grass, houses: M.grass, apartments: M.grass, parking: M.asphalt, warehouses: M.yard, factory: M.yard };
  for (const B of L.blocks) {
    const w = B.x1 - B.x0, d = B.z1 - B.z0;
    const slab = new THREE.BoxGeometry(w, CITY.curb, d);
    slab.translate((B.x0 + B.x1) / 2, CITY.curb / 2, (B.z0 + B.z1) / 2);
    MB.add(M.pavers, applyWorldUV(slab, 0.25));
    cuboid(w / 2, CITY.curb / 2, d / 2, (B.x0 + B.x1) / 2, CITY.curb / 2, (B.z0 + B.z1) / 2);
    // curb stones
    const cw = 0.22;
    for (const [x, z, sw, sd] of [[(B.x0 + B.x1) / 2, B.z0 + cw / 2, w, cw], [(B.x0 + B.x1) / 2, B.z1 - cw / 2, w, cw], [B.x0 + cw / 2, (B.z0 + B.z1) / 2, cw, d], [B.x1 - cw / 2, (B.z0 + B.z1) / 2, cw, d]]) {
      const c = new THREE.BoxGeometry(sw + 0.02, CITY.curb + 0.012, sd + 0.02);
      c.translate(x, CITY.curb / 2 + 0.003, z);
      MB.add(M.curb, applyWorldUV(c, 0.5));
    }
    const im = interiorMat[B.type];
    if (im) {
      const g = new THREE.PlaneGeometry(B.ix1 - B.ix0, B.iz1 - B.iz0);
      g.rotateX(-Math.PI / 2);
      g.translate((B.ix0 + B.ix1) / 2, CITY.curb + 0.004, (B.iz0 + B.iz1) / 2);
      MB.add(im, applyWorldUV(g, im === M.grass ? 1 / 7 : im === M.asphalt ? 1 / 6 : 0.25));
    }
    if (B.type === 'park' || B.type === 'plaza') {
      for (const [gw, gd] of [[B.ix1 - B.ix0, 4], [4, B.iz1 - B.iz0]]) {
        const p = new THREE.PlaneGeometry(gw, gd);
        p.rotateX(-Math.PI / 2);
        p.translate(B.cx, CITY.curb + 0.008, B.cz);
        MB.add(M.pavers, applyWorldUV(p, 0.25));
      }
    }
  }

  // ---------------- roads ----------------
  for (const r of L.roads) {
    const a = r.a, b = r.b;
    SB.quad(M.asphalt, a.x, 0.012, a.z, b.x, 0.012, b.z, r.half * 2, 6);
  }
  // connectors to the ring + boulevard (flat stretch and ramps)
  SB.quad(M.asphalt, 0, 0.012, -CITY.half, 0, 0.012, -RING.offset + RING.halfWidth - 1, 14, 6);
  SB.quad(M.asphalt, 0, 0.012, CITY.half, 0, 0.012, RING.offset - RING.halfWidth + 1, 14, 6);
  SB.quad(M.asphalt, -CITY.half, 0.012, 0, -RING.offset + RING.halfWidth - 1, 0.012, 0, 14, 6);
  const boulevardPts = [];
  for (let x = CITY.half; x <= BOULEVARD.endX + 2; x += 2) boulevardPts.push([x, boulevardY(x), 0]);
  SB.strip(M.asphalt, boulevardPts, 7, 6, 0.012);
  SB.strip(M.highway, L.ring.center, RING.halfWidth, 6, 0.014, true);
  {
    const rg = new THREE.RingGeometry(ROUNDABOUT.island, ROUNDABOUT.outer, 72, 1);
    rg.rotateX(-Math.PI / 2);
    rg.translate(ROUNDABOUT.x, 0.013, ROUNDABOUT.z);
    MB.add(M.asphalt, applyWorldUV(rg, 1 / 6));
    // service road and lot near the roundabout
    SB.quad(M.asphalt, 1086, 0.012, 7, 1086, 0.012, 38, 10, 6);
    const lot = new THREE.PlaneGeometry(75, 20); lot.rotateX(-Math.PI / 2); lot.translate(1087.5, 0.012, 48);
    MB.add(M.asphalt, applyWorldUV(lot, 1 / 6));
  }

  // ---------------- road markings ----------------
  const W = M.markWhite, Y = M.markYellow;
  const dashed = (mat, ax, az, bx, bz, w, dash, gap, yfn = () => 0.03) => {
    const len = Math.hypot(bx - ax, bz - az);
    const tx = (bx - ax) / len, tz = (bz - az) / len;
    for (let s = 0; s < len - dash; s += dash + gap) {
      const x0 = ax + tx * s, z0 = az + tz * s, x1 = ax + tx * (s + dash), z1 = az + tz * (s + dash);
      SB.quad(mat, x0, yfn(x0, z0), z0, x1, yfn(x1, z1), z1, w, 3);
    }
  };
  for (const r of L.roads) {
    const a = r.a, b = r.b;
    const ax = r.axis === 'x' ? 1 : 0, az = 1 - ax;
    const s0 = (r.axis === 'x' ? a.halfX : a.halfZ) + 4.5, s1 = (r.axis === 'x' ? b.halfX : b.halfZ) + 4.5;
    const p0 = [a.x + ax * s0, a.z + az * s0], p1 = [b.x - ax * s1, b.z - az * s1];
    const n = [az, ax]; // perpendicular
    const line = (mat, off, w, dash = 0, gap = 0) => {
      const x0 = p0[0] + n[0] * off, z0 = p0[1] + n[1] * off, x1 = p1[0] + n[0] * off, z1 = p1[1] + n[1] * off;
      if (dash) dashed(mat, x0, z0, x1, z1, w, dash, gap);
      else SB.quad(mat, x0, 0.03, z0, x1, 0.03, z1, w, 3);
    };
    if (r.arterial) {
      line(Y, 0.15, 0.12); line(Y, -0.15, 0.12);
      line(W, 3.5, 0.13, 3, 6); line(W, -3.5, 0.13, 3, 6);
      line(W, r.half - 0.35, 0.15); line(W, -(r.half - 0.35), 0.15);
    } else {
      line(Y, 0, 0.12, 3, 5);
      line(W, 3.3, 0.12); line(W, -3.3, 0.12);
    }
  }
  // stop lines
  for (const I of L.intersections) {
    for (const pid of I.incoming) {
      const p = L.paths[pid];
      if (p.lane !== 0) continue;
      const end = p.pts[p.pts.length - 1];
      const d = p.dir, right = [-d[2], 0, d[0]];
      const off = laneOffsets(p.axis === 'x' ? I.j : I.i);
      const half = off.length === 2 ? 7 : 3.4;
      const cx = end[0] - right[0] * laneOffsets(0)[0] * 0 + d[0] * 0.3 - right[0] * off[0];
      const cz = end[2] + d[2] * 0.3 - right[2] * off[0];
      SB.quad(W, cx + right[0] * 0.2, 0.031, cz + right[2] * 0.2, cx + right[0] * half, 0.031, cz + right[2] * half, 0.45, 3);
    }
  }
  for (const c of L.props.crosswalks) {
    const along = c.axis === 'x' ? [1, 0] : [0, 1];
    const across = [along[1], along[0]];
    for (let o = -c.width / 2 + 0.4; o < c.width / 2 - 0.2; o += 1.1) {
      const x = c.x + across[0] * o, z = c.z + across[1] * o;
      SB.quad(W, x - along[0] * 1.5, 0.031, z - along[1] * 1.5, x + along[0] * 1.5, 0.031, z + along[1] * 1.5, 0.55, 3);
    }
  }
  for (const s of L.props.stallLines) SB.quad(W, s.x, CITY.curb + 0.02, s.z - 2.5, s.x, CITY.curb + 0.02, s.z + 2.5, 0.12, 3);
  // ring markings
  {
    const c = L.ring.center;
    for (const side of [1, -1]) {
      const edge = offsetPolyline(c, side * (RING.halfWidth - 1.6), true);
      const lane = offsetPolyline(c, side * (RING.median + RING.laneW), true);
      const inner = offsetPolyline(c, side * (RING.median + 0.25), true);
      for (let i = 0; i < c.length; i++) {
        const j = (i + 1) % c.length;
        SB.quad(W, edge[i][0], 0.032, edge[i][2], edge[j][0], 0.032, edge[j][2], 0.18, 3);
        SB.quad(Y, inner[i][0], 0.032, inner[i][2], inner[j][0], 0.032, inner[j][2], 0.15, 3);
        if (i % 2 === 0) SB.quad(W, lane[i][0], 0.032, lane[i][2], lane[j][0], 0.032, lane[j][2], 0.14, 3);
      }
    }
    // boulevard markings follow the ramp profile
    const by = (x) => boulevardY(x) + 0.032;
    dashed(W, CITY.half + 12, 3.5, BOULEVARD.endX, 3.5, 0.13, 3, 6, by);
    dashed(W, CITY.half + 12, -3.5, BOULEVARD.endX, -3.5, 0.13, 3, 6, by);
    for (const z of [0.15, -0.15]) dashed(Y, CITY.half + 12, z, BOULEVARD.endX, z, 0.12, 4, 0.01, by);
    for (const z of [6.65, -6.65]) dashed(W, CITY.half + 12, z, BOULEVARD.endX, z, 0.15, 4, 0.01, by);
  }

  // ---------------- buildings ----------------
  const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 24).translate(0, 0.5, 0);
  const feG = PR.fireEscapeGeo(3.4, 3.1), tankG = PR.waterTankGeo(), awnG = PR.awningGeo();
  const signGs = Array.from({ length: 8 }, (_, i) => PR.awningSignGeo(i));
  const AWNING_COLS = [0x1f5b4a, 0x1d2c4f, 0x6e1d1d, 0x18191b, 0xa68a5f, 0x1f6262, 0x3b2a4f];
  const blockOf = (x, z) => {
    const bx = Math.floor((x + CITY.half) / CITY.pitch), bz = Math.floor((z + CITY.half) / CITY.pitch);
    return bx >= 0 && bz >= 0 && bx < CITY.N && bz < CITY.N ? L.blocks[bx * CITY.N + bz] : null;
  };
  /** Outward normal of the facade that faces the nearest street. */
  const frontOf = (b) => {
    const B = blockOf(b.x, b.z);
    if (!B) return { nx: 0, nz: 1, half: b.d / 2 };
    const opts = [
      { nx: -1, nz: 0, gap: b.x - b.w / 2 - B.ix0, half: b.w / 2 }, { nx: 1, nz: 0, gap: B.ix1 - (b.x + b.w / 2), half: b.w / 2 },
      { nx: 0, nz: -1, gap: b.z - b.d / 2 - B.iz0, half: b.d / 2 }, { nx: 0, nz: 1, gap: B.iz1 - (b.z + b.d / 2), half: b.d / 2 },
    ];
    return opts.reduce((a, c) => (c.gap < a.gap ? c : a));
  };
  for (const b of L.buildings) {
    const st = BUILDING_STYLES[b.style] || BUILDING_STYLES.plain;
    const pal = STYLE_TINTS[b.style] || [[1, 1, 1]];
    const col = new THREE.Color(...pal[Math.floor(b.seed * pal.length) % pal.length]);
    const isCyl = b.shape === 'cyl';
    const name = `bld:${b.style}:${isCyl ? 'c' : 'b'}`;
    IB.define(name, isCyl ? unitCyl : unitBox, M.bld[b.style] || M.bld.plain, { cast: true, maxDist: 4000 });
    IB.add(name, trs(b.x, b.y0, b.z, 0, b.w, b.h, b.d), col);
    if (isCyl) cylinder(b.w / 2, b.h, b.x, b.y0, b.z);
    else cuboid(b.w / 2, b.h / 2, b.d / 2, b.x, b.y0 + b.h / 2, b.z, 0, 0.4);
    if (isCyl || st.mode !== 0) continue;
    const top = b.y0 + b.h;
    // cornice: stepped crown moulding, plus a belt course over the storefront base
    if (b.cornice) {
      for (const [grow, hh, dy] of [[0.35, 0.4, -1.05], [0.8, 0.22, -0.62], [1.3, 0.42, -0.4]]) {
        const g = new THREE.BoxGeometry(b.w + grow, hh, b.d + grow);
        g.translate(b.x, top + dy + hh / 2, b.z);
        MB.add(M.cornice, applyWorldUV(g, 1 / 3), { cast: true, maxDist: 1600 });
      }
      if (b.y0 < 1 && st.baseH > 0 && b.h > st.baseH + 3) {
        const g = new THREE.BoxGeometry(b.w + 0.35, 0.38, b.d + 0.35);
        g.translate(b.x, st.baseH + 0.1, b.z);
        MB.add(M.cornice, applyWorldUV(g, 1 / 3), { cast: true, maxDist: 900 });
      }
    }
    const f = frontOf(b);
    const rotF = Math.atan2(f.nx, f.nz);
    const Xd = [Math.cos(rotF), -Math.sin(rotF)]; // local +X after rotation
    const cx = b.x + f.nx * (f.half + 0.02), cz = b.z + f.nz * (f.half + 0.02);
    // fire escape stack on the street facade
    if (b.fe) {
      const baseH = b.y0 < 1 ? st.baseH : 0;
      const floors = Math.floor((b.h - baseH - 1) / st.floorH);
      const off = (b.seed - 0.5) * Math.max(0, (f.nx ? b.d : b.w) - 8);
      for (let k = 0; k < floors; k++) {
        const y = b.y0 + baseH + k * st.floorH + 0.05;
        const ox = cx + Xd[0] * (off - 1.7), oz = cz + Xd[1] * (off - 1.7);
        IB.addParts('fe', feG, M, trs(ox, y, oz, rotF), { maxDist: 340 });
      }
    }
    if (b.tank) {
      const ox = (b.seed * 13.7 % 1 - 0.5) * Math.max(0, b.w - 6), oz = (b.seed * 7.3 % 1 - 0.5) * Math.max(0, b.d - 6);
      IB.addParts('tank', tankG, M, trs(b.x + ox, top, b.z + oz, b.seed * 6), { cast: true, maxDist: 1600 });
    }
    // storefront awnings, aligned with the shader's 4.2 m shop bays
    if (b.y0 < 1 && st.store >= 1 && st.baseH > 0) {
      const T = [-f.nz, f.nx];
      const c0 = cx * T[0] + cz * T[1];
      const span = f.nx ? b.d : b.w;
      for (let k = Math.ceil((c0 - span / 2) / 4.2); (k + 1) * 4.2 <= c0 + span / 2; k++) {
        const h = Math.abs(Math.sin(k * 12.9898 + b.seed * 78.233) * 43758.5453) % 1;
        if (h < 0.45) continue;
        const sOff = (k + 0.5) * 4.2 - c0;
        const ax = cx + T[0] * sOff, az = cz + T[1] * sOff;
        const m = trs(ax, st.baseH - 1.45, az, rotF);
        IB.define('awning', awnG.awning, M.awning, { cast: true, maxDist: 500 });
        IB.add('awning', m, new THREE.Color(AWNING_COLS[Math.floor(h * 97) % AWNING_COLS.length]));
        const row = Math.floor(h * 131) % 8;
        IB.define('sign' + row, signGs[row], M.signText, { maxDist: 220 });
        IB.add('sign' + row, m);
      }
    }
  }

  // ---------------- street furniture ----------------
  const P = L.props;
  const near = { maxDist: 260 };
  const mid = { maxDist: 600, cast: false }; // thin poles: their shadows cost a draw call each and barely read
  const lightGeos = {};
  for (const s of P.streetlights) {
    const kind = s.kind || 'single';
    lightGeos[kind] ||= PR.streetlightGeo(kind);
    const lg = lightGeos[kind];
    const rot = kind === 'highway' ? s.rot + Math.PI / 2 : s.rot;
    const y = s.y ?? 0;
    const { lampOffsets, ...lparts } = lg;
    const handles = IB.addParts('light_' + kind, lparts, M, trs(s.x, y, s.z, rot), { maxDist: 900, cast: false });
    const myLamps = [];
    for (const o of lampOffsets) {
      const c = Math.cos(rot), sn = Math.sin(rot);
      const lp = { x: s.x + o[0] * c + o[2] * sn, y: y + o[1], z: s.z - o[0] * sn + o[2] * c, mode: 'night', kind };
      lamps.push(lp); myLamps.push(lp);
    }
    if (kind !== 'highway') {
      const h = kind === 'double' ? 9 : kind === 'lot' ? 9 : 7.5;
      makeBreakable('light', lparts, handles, s.x, y, s.z, rot, { hx: 0.13, hy: h / 2, hz: 0.13, cy: h / 2 }, 230, 7, { lamps: myLamps });
    }
  }

  // traffic signals: poles + per-lamp instanced discs coloured by the traffic system
  const signalLampGeo = PR.signalLampGeo();
  const lampInstances = [];
  for (const s of P.signals) {
    const arm = Math.round(s.arm * 2) / 2;
    const geo = PR.signalGeo(arm);
    const sHandles = IB.addParts('signal_' + arm, geo, M, trs(s.x, s.y, s.z, s.rot), mid);
    const firstLamp = lampInstances.length;
    const offs = PR.signalLampOffsets(arm);
    const c = Math.cos(s.rot), sn = Math.sin(s.rot);
    for (const head of offs) {
      head.forEach((o, k) => {
        lampInstances.push({ inter: s.inter, axis: s.axis, k, m: trs(s.x + o[0] * c + o[2] * sn, s.y + o[1], s.z - o[0] * sn + o[2] * c, s.rot) });
      });
    }
    makeBreakable('signal', geo, sHandles, s.x, s.y, s.z, s.rot, { hx: 0.15, hy: 3.1, hz: 0.15, cy: 3.1 }, 420, 12,
      { signalIdx: Array.from({ length: lampInstances.length - firstLamp }, (_, i) => firstLamp + i) });
  }
  const signalLamps = new THREE.InstancedMesh(signalLampGeo, M.signalLamp, Math.max(1, lampInstances.length));
  lampInstances.forEach((li, i) => { signalLamps.setMatrixAt(i, li.m); signalLamps.setColorAt(i, new THREE.Color(0.05, 0.05, 0.05)); });
  signalLamps.count = lampInstances.length;
  signalLamps.computeBoundingSphere();
  scene.add(signalLamps);

  const stopMat = new THREE.MeshStandardMaterial({ map: makeSignTex('stop'), roughness: 0.4, transparent: true, alphaTest: 0.5 });
  const MX = { ...M, stopFace: stopMat, bump: new THREE.MeshStandardMaterial({ color: 0xd6b21e, roughness: 0.6 }) };
  const stopG = PR.stopSignGeo();
  for (const s of P.stopSigns) makeBreakable('stop', stopG, IB.addParts('stop', stopG, MX, trs(s.x, s.y, s.z, s.rot), near), s.x, s.y, s.z, s.rot, { hx: 0.2, hy: 1.3, hz: 0.06, cy: 1.3 }, 35, 2.5);
  const benchG = PR.benchGeo(), binG = PR.binGeo(), hydG = PR.hydrantGeo(), meterG = PR.meterGeo(), busG = PR.busStopGeo(), uG = PR.utilityPoleGeo();
  for (const b of P.benches) { const y = b.y ?? CITY.curb; makeBreakable('bench', benchG, IB.addParts('bench', benchG, M, trs(b.x, y, b.z, b.rot || 0), near), b.x, y, b.z, b.rot || 0, { hx: 0.9, hy: 0.42, hz: 0.25, cy: 0.42 }, 55, 2); }
  for (const b of P.bins) { const y = b.y ?? CITY.curb; makeBreakable('bin', binG, IB.addParts('bin', binG, M, trs(b.x, y, b.z, 0), near), b.x, y, b.z, 0, { hx: 0.29, hy: 0.5, hz: 0.29, cy: 0.5 }, 18, 1.2); }
  for (const h of P.hydrants) makeBreakable('hydrant', hydG, IB.addParts('hydrant', hydG, M, trs(h.x, h.y, h.z, 0), near), h.x, h.y, h.z, 0, { hx: 0.15, hy: 0.38, hz: 0.15, cy: 0.38 }, 90, 6);
  for (const m of P.meters) makeBreakable('meter', meterG, IB.addParts('meter', meterG, M, trs(m.x, m.y, m.z, m.rot), near), m.x, m.y, m.z, m.rot, { hx: 0.1, hy: 0.7, hz: 0.1, cy: 0.7 }, 22, 2);
  for (const b of P.busStops) {
    IB.addParts('bus', busG, M, trs(b.x, b.y, b.z, b.rot), { maxDist: 400, cast: false });
    cuboid(2.0, 1.3, 0.9, b.x, b.y + 1.3, b.z, b.rot);
  }
  // utility poles + overhead wires
  const wirePos = [];
  let prev = null;
  for (const u of P.utilityPoles) {
    const rot = u.axis === 'x' ? 0 : Math.PI / 2;
    makeBreakable('upole', uG, IB.addParts('upole', uG, M, trs(u.x, u.y, u.z, rot), mid), u.x, u.y, u.z, rot, { hx: 0.16, hy: 5, hz: 0.16, cy: 5 }, 450, 14);
    if (prev && Math.hypot(prev.x - u.x, prev.z - u.z) < 34 && prev.axis === u.axis) {
      for (const o of [-0.9, 0, 0.9]) {
        const ox = u.axis === 'x' ? o : 0, oz = u.axis === 'x' ? 0 : o;
        const mx = (prev.x + u.x) / 2, mz = (prev.z + u.z) / 2;
        const pts = [[prev.x + ox, 9.5, prev.z + oz], [mx + ox, 8.9, mz + oz], [u.x + ox, 9.5, u.z + oz]];
        wirePos.push(...pts[0], ...pts[1], ...pts[1], ...pts[2]);
      }
    }
    prev = u;
  }
  if (wirePos.length) {
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wirePos, 3));
    const wires = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x111111 }));
    scene.add(wires);
  }
  // fences
  for (const f of P.fences) {
    const len = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
    const rot = Math.atan2(f.x1 - f.x0, f.z1 - f.z0);
    const mx = (f.x0 + f.x1) / 2, mz = (f.z0 + f.z1) / 2;
    if (f.kind === 'chain') {
      const panel = new THREE.PlaneGeometry(len, 2.2, 1, 1);
      const uv = panel.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 1.2, uv.getY(i) * 2.2 / 1.2);
      panel.rotateY(rot + Math.PI / 2);
      panel.translate(mx, CITY.curb + 1.1, mz);
      MB.add(M.chain, panel);
    } else {
      const pl = [];
      for (let t = 0; t < len; t += 0.16) pl.push(new THREE.BoxGeometry(0.12, 1.6, 0.025).translate(t - len / 2, 0.8, 0));
      const g = mergeGeometries(pl.map((x) => x.toNonIndexed()));
      g.rotateY(rot - Math.PI / 2);
      g.translate(mx, CITY.curb, mz);
      MB.add(M.wood, g, { cast: true, maxDist: 400 });
    }
    for (let t = 0; t <= len; t += 3) {
      const x = f.x0 + (f.x1 - f.x0) * (t / len), z = f.z0 + (f.z1 - f.z0) * (t / len);
      IB.define('fencepost', new THREE.CylinderGeometry(0.04, 0.04, 2.3, 6).translate(0, 1.15, 0), M.galv, near);
      IB.add('fencepost', trs(x, CITY.curb, z));
    }
    cuboid(0.06, 1.1, len / 2, mx, CITY.curb + 1.1, mz, rot);
  }
  // highway barriers
  const jG = PR.jerseyGeo(), rG = PR.railGeo();
  for (const b of P.barriers) {
    if (b.kind === 'jersey') {
      IB.addParts('jersey', jG, M, trs(b.x, 0, b.z, b.rot, 1, 1, b.len + 0.05), { maxDist: 700, cast: false });
      cuboid(0.25, 0.42, b.len / 2, b.x, 0.42, b.z, b.rot, 0.3);
    } else {
      IB.addParts('rail', rG, M, trs(b.x, 0, b.z, b.rot, 1, 1, b.len + 0.05), { maxDist: 500 });
      cuboid(0.08, 0.45, b.len / 2, b.x, 0.45, b.z, b.rot, 0.3);
    }
  }
  // speed bumps
  const bumpG = PR.speedBumpGeo();
  for (const s of P.speedBumps) {
    const rot = s.axis === 'x' ? Math.PI / 2 : 0;
    IB.addParts('bump', bumpG, MX, trs(s.x, 0.01, s.z, rot, s.width, 1, 0.9), near);
    cuboid(s.width / 2, 0.04, 0.3, s.x, 0.04, s.z, rot);
  }
  // containers
  const cG = PR.containerGeo();
  for (const c of P.containers) {
    IB.addParts('container', cG, M, trs(c.x, CITY.curb + c.y, c.z, c.rot), { maxDist: 700, cast: true }, new THREE.Color(c.color));
    cuboid(3.03, 1.3, 1.22, c.x, CITY.curb + c.y + 1.3, c.z, c.rot);
  }
  // billboards
  const bbG = PR.billboardGeo();
  const adMats = [];
  for (let i = 0; i < 6; i++) adMats.push(new THREE.MeshStandardMaterial({ map: makeBillboard(i), roughness: 0.5, emissive: 0xffffff, emissiveMap: null, emissiveIntensity: 0 }));
  for (const b of P.billboards) {
    const m = trs(b.x, 0, b.z, b.rot);
    IB.addParts('bb', { darkMetal: bbG.darkMetal }, M, m, { maxDist: 1500, cast: true });
    const fk = 'bbface' + b.ad;
    IB.define(fk, bbG.face, adMats[b.ad], { maxDist: 1500 });
    IB.add(fk, m);
    lamps.push({ x: b.x, y: 8, z: b.z, mode: 'night', kind: 'billboard' });
    cylinder(0.3, 6, b.x - 3.5 * Math.cos(b.rot), 0, b.z + 3.5 * Math.sin(b.rot));
    cylinder(0.3, 6, b.x + 3.5 * Math.cos(b.rot), 0, b.z - 3.5 * Math.sin(b.rot));
  }
  // gantries
  for (const g of P.gantries) {
    const gg = PR.gantryGeo(RING.halfWidth * 2 + 2);
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(gg.galv, M.galv));
    grp.add(new THREE.Mesh(gg.face, new THREE.MeshStandardMaterial({ map: makeSignTex('gantry', g.text), roughness: 0.35, emissive: 0xffffff, emissiveIntensity: 0.05, emissiveMap: null })));
    grp.children.forEach((c) => { c.castShadow = true; });
    // gantries span the expressway; rotate so the span is across the road
    grp.position.set(g.x, 0, g.z);
    grp.rotation.y = g.rot + Math.PI / 2;
    scene.add(grp);
    const c = Math.cos(grp.rotation.y), s = Math.sin(grp.rotation.y);
    for (const side of [-1, 1]) {
      const off = side * (RING.halfWidth + 1);
      cuboid(0.3, 4, 0.3, g.x + off * c, 4, g.z - off * s);
    }
  }

  // ---------------- vegetation ----------------
  const treeGeos = [0, 1, 2].map((k) => [PR.branchyTreeGeo(k, 1)]); // one variant per species: half the tree draw calls
  const guardG = PR.treeGuardGeo();
  const T = TUNNEL;
  for (const t of P.trees) {
    if (t.x > T.x0 - 6 && t.x < T.x1 + 6 && Math.abs(t.z - T.z) < 75) continue;
    const v = 0;
    const tg = treeGeos[t.kind][v];
    const y = t.y ?? (L.surfaceAt(t.x, t.z) === SURF.ROAD ? -100 : surfaceY(L, t.x, t.z));
    if (y < -50) continue;
    const s = t.s * (t.pit ? 1.05 : 1.25);
    const hue = new THREE.Color().setHSL(0.17 + rnd() * 0.07, 0.12 + rnd() * 0.12, 0.6 + rnd() * 0.16);
    const m = trs(t.x, y, t.z, rnd() * Math.PI * 2, s, s * (0.9 + rnd() * 0.25), s);
    const key = 'tree' + t.kind + '_' + v;
    IB.define(key + ':bark', tg.bark, M.bark, { cast: true, maxDist: 900 });
    IB.define(key + ':leaves', tg.leaves, M.leavesSparse[t.kind], { cast: true, maxDist: 900 });
    IB.add(key + ':bark', m);
    IB.add(key + ':leaves', m, hue);
    if (t.pit) IB.addParts('guard', guardG, M, trs(t.x, y, t.z, 0), { maxDist: 220 });
    cylinder(0.22 * s, 3, t.x, y, t.z);
  }
  const grassG = PR.grassClumpGeo();
  grassBatches.define('grass', grassG.grassBlades, M.grassBlades, { maxDist: 95 });
  for (const a of P.grass) {
    const area = (a.x1 - a.x0) * (a.z1 - a.z0);
    const n = Math.floor(area * a.density * 0.22);
    for (let i = 0; i < n; i++) {
      const x = a.x0 + rnd() * (a.x1 - a.x0), z = a.z0 + rnd() * (a.z1 - a.z0);
      if (L.surfaceAt(x, z) !== SURF.PARK) continue;
      const s = 0.6 + rnd() * 0.8;
      grassBatches.add('grass', trs(x, CITY.curb, z, rnd() * Math.PI, s, s * (0.7 + rnd() * 0.6), s), new THREE.Color().setHSL(0.19 + rnd() * 0.06, 0.24, 0.45 + rnd() * 0.2));
    }
  }

  // ---------------- street clutter ----------------
  const CL = {
    bags: [2, 3, 4, 5].map((n, i) => PR.trashBagsGeo(n, 3 + i)), boxes: [PR.boxesGeo(5), PR.boxesGeo(8)],
    newsbox: PR.newsBoxGeo(), cart: PR.cartGeo(), crowdbarrier: PR.crowdBarrierGeo(), barrier: PR.plasticBarrierGeo(),
    cone: PR.coneGeo(), steam: PR.steamStackGeo(), pallets: [PR.palletsGeo(2), PR.palletsGeo(5)], drums: [PR.drumsGeo(1), PR.drumsGeo(3)],
    tires: [PR.tiresGeo(2), PR.tiresGeo(4)], tarp: [PR.tarpGeo(9), PR.tarpGeo(4)], bricks: [PR.bricksGeo()],
  };
  const BARRIER_COLS = [new THREE.Color(0xe0571c), new THREE.Color(0xeeeeea)];
  // collision box (local, centre height cy), mass (kg) and the impact speed (m/s) that knocks it loose
  const CLUTTER_PHYS = {
    barrier: { shape: { hx: 0.9, hy: 0.5, hz: 0.28, cy: 0.5 }, mass: 110, breakSpeed: 0.8 },
    steam: { shape: { hx: 0.38, hy: 1.3, hz: 0.38, cy: 1.3 }, mass: 30, breakSpeed: 0.8 },
    cone: { shape: { hx: 0.17, hy: 0.36, hz: 0.17, cy: 0.36 }, mass: 4, breakSpeed: 0.3 },
    crowdbarrier: { shape: { hx: 1.15, hy: 0.55, hz: 0.12, cy: 0.55 }, mass: 22, breakSpeed: 0.8 },
    cart: { shape: { hx: 1.0, hy: 0.7, hz: 0.48, cy: 0.75 }, mass: 160, breakSpeed: 2.5 },
    newsbox: { shape: { hx: 0.25, hy: 0.55, hz: 0.22, cy: 0.55 }, mass: 28, breakSpeed: 1.2 },
    bags: { shape: { hx: 0.6, hy: 0.35, hz: 0.45, cy: 0.35 }, mass: 25, breakSpeed: 0.4 },
    boxes: { shape: { hx: 0.55, hy: 0.35, hz: 0.4, cy: 0.35 }, mass: 8, breakSpeed: 0.3 },
    pallets: { shape: { hx: 0.6, hy: 0.35, hz: 0.5, cy: 0.35 }, mass: 22, breakSpeed: 1.5 },
    drums: { shape: { hx: 0.55, hy: 0.45, hz: 0.55, cy: 0.45 }, mass: 55, breakSpeed: 1.5 },
    tires: { shape: { hx: 0.45, hy: 0.4, hz: 0.45, cy: 0.4 }, mass: 30, breakSpeed: 1 },
    tarp: { shape: { hx: 1.15, hy: 0.55, hz: 0.85, cy: 0.55 }, mass: 70, breakSpeed: 2 },
    bricks: { shape: { hx: 0.6, hy: 0.45, hz: 0.5, cy: 0.45 }, mass: 700, breakSpeed: 6 },
  };
  for (const c of P.clutter) {
    const set = CL[c.kind];
    if (!set) continue;
    const variant = Array.isArray(set) ? set[Math.min(set.length - 1, Math.floor(((c.n || 1) - 1) / 2))] : set;
    const key = c.kind + (Array.isArray(set) ? set.indexOf(variant) : '');
    const color = c.kind === 'barrier' ? BARRIER_COLS[c.color] : c.color != null ? new THREE.Color(c.color) : null;
    const big = ['barrier', 'cart', 'steam', 'tarp', 'pallets', 'bricks', 'crowdbarrier'].includes(c.kind);
    const ch = IB.addParts('cl_' + key, variant, M, trs(c.x, c.y, c.z, c.rot), { cast: big, maxDist: big ? 320 : 200 }, color);
    const spec = CLUTTER_PHYS[c.kind];
    if (spec) makeBreakable(c.kind, variant, ch, c.x, c.y, c.z, c.rot, spec.shape, spec.mass * (c.n || 1) ** (c.kind === 'pallets' || c.kind === 'drums' ? 1 : 0), spec.breakSpeed, { color });
  }
  // decals (manholes, patches, stains, arrows, litter) from one atlas
  for (const d of P.decals) SB.decal(M.decal, d.x, d.y, d.z, d.w, d.l, d.rot, d.cell);

  // ---------------- structures ----------------
  buildBridge({ scene, M, SB, MB, IB, cuboid, cylinder, RAPIER, world, lamps, jG });
  const tunnel = buildTunnel({ scene, M, RAPIER, world, lamps, IB, cuboid });
  buildRoundabout({ scene, M, MB, cylinder });
  buildMountains(scene, M);

  IB.build();
  grassBatches.build();
  SB.build();
  MB.build();

  return { cull, lamps, signalLamps, lampInstances, tunnel, registerStatic, retire, updateStreaming, statics, breakables, propOwner, breakProp, updateDebris, IB };
}

function surfaceY(L, x, z) {
  const s = L.surfaceAt(x, z);
  return s === SURF.GROUND || s === SURF.HIGHWAY || s === SURF.ROAD ? 0 : CITY.curb;
}

function buildBridge({ scene, M, SB, MB, IB, cuboid, cylinder, RAPIER, world, lamps, jG }) {
  const half = 7.4;
  const x0 = BOULEVARD.upA, x1 = BOULEVARD.downB;
  // deck underside / skirts where the road is elevated
  const pos = [];
  const step = 2;
  for (let x = x0; x < x1; x += step) {
    const ya = boulevardY(x), yb = boulevardY(x + step);
    if (ya < 0.6 && yb < 0.6) continue;
    const da = ya - 1.3, db = yb - 1.3;
    for (const z of [-half, half]) pos.push(x, ya, z, x + step, yb, z, x, da, z, x + step, yb, z, x + step, db, z, x, da, z);
    pos.push(x, da, -half, x + step, db, -half, x, da, half, x + step, db, -half, x + step, db, half, x, da, half);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  applyWorldUV(g, 0.25);
  const skirt = new THREE.Mesh(g, M.bridge);
  skirt.material = M.bridge.clone();
  skirt.material.side = THREE.DoubleSide;
  skirt.castShadow = true; skirt.receiveShadow = true;
  scene.add(skirt);
  // piers
  for (let x = x0 + 18; x < x1 - 10; x += 16) {
    const y = boulevardY(x);
    if (y < 2.5) continue;
    if (Math.abs(x - RING.offset) < RING.halfWidth + 1.5 && Math.abs(x - RING.offset) > 1) continue; // keep expressway lanes clear
    const h = y - 1.3;
    const pier = new THREE.BoxGeometry(1.4, h, 9);
    pier.translate(x, h / 2, 0);
    MB.add(M.bridge, applyWorldUV(pier, 0.25), { cast: true });
    cuboid(0.7, h / 2, 4.5, x, h / 2, 0);
  }
  // deck collision surface (trimesh following the ramp profile)
  const verts = [], idx = [];
  let k = 0;
  for (let x = x0 - 6; x <= x1 + 6; x += 2) {
    const y = boulevardY(x);
    verts.push(x, y, -half, x, y, half);
    if (k > 0) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    k++;
  }
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx)).setFriction(0.9));
  // parapets
  for (let x = x0 + 4; x < x1 - 4; x += 4) {
    const ya = boulevardY(x), yb = boulevardY(x + 4);
    if (ya < 0.9 && yb < 0.9) continue;
    const pitch = Math.atan2(yb - ya, 4);
    for (const z of [-half + 0.3, half - 0.3]) {
      IB.addParts('jersey', jG, M, trs(x + 2, (ya + yb) / 2, z, Math.PI / 2, 1, 1, 4.05, -pitch), { maxDist: 900, cast: false });
      const d = RAPIER.ColliderDesc.cuboid(2, 0.45, 0.25).setTranslation(x + 2, (ya + yb) / 2 + 0.42, z);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, pitch));
      d.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      world.createCollider(d);
    }
  }
}

function buildTunnel({ scene, M, RAPIER, world, lamps, IB }) {
  const T = TUNNEL;
  const len = T.x1 - T.x0;
  const hw = 13.2, wall = 5.0, archR = 13.2, archCy = T.archH - 4.0;
  const hill = new THREE.Shape();
  const prof = [[-78, -0.6], [-60, 3], [-44, 9], [-30, 15], [-14, 19.5], [0, 21], [16, 19], [32, 14.5], [48, 8], [64, 2.5], [78, -0.6]];
  hill.moveTo(prof[0][0], prof[0][1]);
  for (let i = 1; i < prof.length; i++) hill.lineTo(prof[i][0], prof[i][1]);
  hill.closePath();
  const archPath = (inset) => {
    const p = new THREE.Path();
    p.moveTo(-hw + inset, -0.3);
    p.lineTo(-hw + inset, wall);
    p.absellipse(0, wall, hw - inset, archCy + 3.6 - wall - inset * 0.5 + 1.6, Math.PI, 0, true);
    p.lineTo(hw - inset, -0.3);
    p.closePath();
    return p;
  };
  hill.holes.push(archPath(0));
  const hg = new THREE.ExtrudeGeometry(hill, { depth: len, bevelEnabled: false, curveSegments: 24 });
  hg.rotateY(Math.PI / 2);
  hg.translate(T.x0, 0, T.z);
  applyWorldUV(hg, 1 / 7);
  const portal = M.tunnel.clone(); portal.side = THREE.DoubleSide;
  const hillMesh = new THREE.Mesh(hg, [portal, M.hill]);
  hillMesh.castShadow = true; hillMesh.receiveShadow = true;
  scene.add(hillMesh);
  const pa = hg.attributes.position.array;
  const ia = hg.index ? hg.index.array : Uint32Array.from({ length: pa.length / 3 }, (_, i) => i);
  world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(pa), new Uint32Array(ia)).setFriction(0.5));
  // inner liner (tiled concrete)
  const linerShape = new THREE.Shape(archPath(0).getPoints(48));
  linerShape.holes.push(archPath(0.35));
  const lg = new THREE.ExtrudeGeometry(linerShape, { depth: len + 0.6, bevelEnabled: false, curveSegments: 24 });
  lg.rotateY(Math.PI / 2);
  lg.translate(T.x0 - 0.3, 0, T.z);
  applyWorldUV(lg, 0.3);
  const liner = new THREE.Mesh(lg, M.tunnelTile);
  liner.receiveShadow = true;
  scene.add(liner);
  // lamp strips
  const strip = new THREE.BoxGeometry(2.4, 0.08, 0.35);
  const lampMeshG = [];
  for (let x = T.x0 + 6; x < T.x1; x += 12) {
    for (const s of [-1, 1]) {
      const y = wall + 3.6;
      lampMeshG.push(strip.clone().translate(x, y, T.z + s * 6.5));
      lamps.push({ x, y: y - 0.3, z: T.z + s * 6.5, mode: 'always', kind: 'tunnel' });
    }
  }
  const lm = new THREE.Mesh(mergeGeometries(lampMeshG), M.tunnelLamp);
  scene.add(lm);
  return { x0: T.x0, x1: T.x1, z: T.z, halfWidth: hw };
}

function buildRoundabout({ scene, M, MB, cylinder }) {
  const R = ROUNDABOUT;
  const island = new THREE.CylinderGeometry(R.island, R.island, 0.3, 64);
  island.translate(R.x, 0.15, R.z);
  MB.add(M.grass, applyWorldUV(island, 1 / 7));
  const curb = new THREE.CylinderGeometry(R.island + 0.25, R.island + 0.25, 0.22, 64, 1, true);
  curb.translate(R.x, 0.11, R.z);
  MB.add(M.curb, applyWorldUV(curb, 0.5));
  cylinder(R.island, 0.3, R.x, 0, R.z);
  // landmark sculpture: steel arc on a plinth
  const plinth = new THREE.BoxGeometry(5, 1.2, 5).translate(R.x, 0.6, R.z);
  MB.add(M.concrete, applyWorldUV(plinth, 0.25), { cast: true });
  const arc = new THREE.TorusGeometry(5.5, 0.35, 16, 64, Math.PI * 1.35);
  const am = new THREE.Mesh(arc, M.chrome);
  am.position.set(R.x, 1.2, R.z);
  am.rotation.set(0, Math.PI / 4, Math.PI * 0.08);
  am.castShadow = true;
  scene.add(am);
  cylinder(2.5, 1.2, R.x, 0, R.z);
}

function buildMountains(scene, M) {
  const rnd = mulberry32(808);
  const geos = [];
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rnd() * 0.05;
    const r = 2600 + rnd() * 700;
    const h = 110 + rnd() * 230;
    // smooth massif: concave slopes and low-frequency ridges (a function of angle, so the seam closes)
    const R = 520 + rnd() * 520;
    let g = new THREE.ConeGeometry(R, h, 36, 10, true);
    const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), z = p.getZ(k), rf = Math.min(1, Math.hypot(x, z) / R), ang = Math.atan2(z, x);
      const n = 0.2 * Math.sin(3 * ang + ph[0]) + 0.1 * Math.sin(5 * ang + ph[1]) + 0.05 * Math.sin(11 * ang + ph[2]);
      p.setXYZ(k, x * (1 + n), -h / 2 + h * Math.pow(1 - rf, 1.5) * (1 + 0.5 * n * rf), z * (1 + n));
    }
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    g = mergeVertices(g, 0.5);
    g.translate(Math.cos(a) * r + 300, h / 2 - 20, Math.sin(a) * r);
    geos.push(g);
  }
  const g = mergeGeometries(geos);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, M.mountain);
  m.matrixAutoUpdate = false;
  scene.add(m);
}
