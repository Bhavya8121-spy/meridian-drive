// Lane-graph traffic: IDM car-following, traffic lights and stop signs, pooled kinematic bodies,
// instanced rendering (one draw call per car part per body type).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNpcGeometry } from '../vehicle/carModel.js';
import { CAR_MODELS, getKit } from '../vehicle/gltfCars.js';
import { InstanceBatches } from '../world/batching.js';
import { GROUPS, G, groups } from '../core/physicsGroups.js';
import { signalState } from '../world/layout.js';
import { clamp, lerp } from '../core/rng.js';

const PROC_TYPES = ['sedan', 'hatch', 'suv', 'van'];
const PAINTS = [0xf2f2f0, 0x111214, 0xa9adb3, 0x5b6068, 0x1d2f55, 0x7a1414, 0xc9b99a, 0x1f3b2c, 0x2f4f6f, 0xe8e2d0, 0x3a3a3c, 0x8c1c13];

const _w0 = new THREE.Vector3(), _ahead = new THREE.Vector3(), _behind = new THREE.Vector3();
const _m = new THREE.Matrix4(), _w = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _c = new THREE.Color();

function pointAt(path, s, out, hint = 0) {
  const cum = path.cum, pts = path.pts;
  s = clamp(s, 0, path.len);
  let i = Math.min(hint, cum.length - 2);
  while (i > 0 && cum[i] > s) i--;
  while (i < cum.length - 2 && cum[i + 1] < s) i++;
  const a = pts[i], b = pts[i + 1];
  const seg = cum[i + 1] - cum[i] || 1;
  const t = (s - cum[i]) / seg;
  out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  return i;
}

export class TrafficSystem {
  constructor({ scene, layout, M, RAPIER, world, maxCars = 40, cull, registerStatic = (c) => c, retire = () => {} }) {
    this.L = layout;
    this.R = RAPIER;
    this.world = world;
    this.scene = scene;
    this.time = 0;
    this.maxCars = maxCars;
    this.activeLimit = maxCars;
    this.onHonk = null;
    this.headlights = 0;

    const parked = layout.props.parkedCars;
    this.parkedOwner = new Map(); // collider handle -> parked car record
    this.carOwner = new Map();    // collider handle -> pooled car
    this.retire = retire;
    // ---- body types: imported models when loaded (gltfCars), else the procedural bodies ----
    const kitDefs = Object.entries(CAR_MODELS).map(([key, meta]) => ({ key, meta, kit: getKit(key) }));
    const useKits = kitDefs.every((d) => d.kit);
    const defs = useKits ? kitDefs : PROC_TYPES.map((name) => ({ key: name, meta: { weight: 1, far: name } }));
    // weighted pool: which body type each pooled car uses (largest remainder over the weights)
    const wsum = defs.reduce((s, d) => s + d.meta.weight, 0);
    const counts = defs.map((d) => Math.floor((d.meta.weight / wsum) * maxCars));
    while (counts.reduce((s, c) => s + c, 0) < maxCars) counts[counts.indexOf(Math.min(...counts))]++;
    const assign = [];
    for (let k = 0; Math.max(...counts) > 0; k++) for (let ti = 0; ti < defs.length; ti++) if (counts[ti] > 0) { counts[ti]--; assign.push(ti); }
    const procCache = {};
    const proc = (name, lod) => (procCache[name + lod] ||= createNpcGeometry(name, lod));
    const mk = (geo, mat, cast, count) => {
      const im = new THREE.InstancedMesh(geo, mat, count);
      im.castShadow = cast; im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      scene.add(im);
      return im;
    };
    const kitMaterial = (part, M) => {
      if (part.slot === 'paint') {
        if (part.material.map) return part.material; // livery (taxi, police)
        const m = M.npcPaint.clone();
        if (part.material.normalMap) { m.normalMap = part.material.normalMap; m.normalScale = new THREE.Vector2(1, 1); }
        return m;
      }
      if (part.slot === 'glass') return M.npcGlass;
      if (part.slot === 'lightF' || part.slot === 'lightR') return new THREE.MeshBasicMaterial({ map: part.material.map, color: 0xffffff });
      const m = part.material;
      if (m.transparent && !/Lightbar/i.test(m.name)) { m.transparent = false; m.alphaTest = 0.5; }
      return m;
    };
    this.types = defs.map((d, ti) => {
      const cap = Math.max(1, assign.filter((x) => x === ti).length);
      const t = { name: d.key, meta: d.meta, pool: cap, parts: {}, wheelMeshes: [], kitMats: {} };
      if (useKits) {
        const kit = d.kit;
        t.params = kit.params;
        t.wheels = kit.params.wheels;
        for (const [k, part] of Object.entries(kit.parts)) {
          const mat = kitMaterial(part, M);
          t.kitMats[k] = mat;
          const slot = ['paint', 'glass', 'lightF', 'lightR'].includes(part.slot) ? part.slot : k;
          t.parts[slot] = mk(part.geo, mat, part.slot === 'paint', cap); // the paint shell carries the car's shadow
        }
        t.wheelMeshes.push(mk(kit.wheel.geo, kit.wheel.material, true, cap * 4));
      } else {
        const g = proc(d.key, 1);
        t.params = { ...g.params, H: g.params.roofY };
        t.wheels = g.wheels;
        t.parts = { paint: mk(g.geo.paint, M.npcPaint, true, cap), glass: mk(g.geo.glass, M.npcGlass, false, cap), trim: mk(g.geo.trim, M.trim, true, cap),
          lightF: mk(g.geo.lightF, M.npcLightF, false, cap), lightR: mk(g.geo.lightR, M.npcLightR, false, cap) };
        t.wheelMeshes.push(mk(g.geo.tire, M.tire, true, cap * 4), mk(g.geo.rim, M.rim, false, cap * 4));
      }
      t.partList = Object.values(t.parts);
      if (useKits) {
        // parked cars never light up: merge every part that shares a material (the lamps share one atlas) into one draw
        const byMat = new Map();
        for (const [k, part] of Object.entries(d.kit.parts)) {
          const mat = part.slot === 'paint' ? t.kitMats[k] : part.slot === 'glass' ? M.npcGlass : part.material;
          if (!byMat.has(mat)) byMat.set(mat, { mat, list: [], paint: part.slot === 'paint' });
          byMat.get(mat).list.push(part.geo);
        }
        t.parkedParts = [...byMat.values()].map((b, i) => ({ name: `${d.key}:p${i}`, mat: b.mat, paint: b.paint, geo: b.list.length > 1 ? mergeGeometries(b.list) : b.list[0] }));
      }
      t.paint = t.parts.paint; t.lightF = t.parts.lightF; t.lightR = t.parts.lightR;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < cap; i++) {
        for (const im of t.partList) im.setMatrixAt(i, zero);
        for (const im of t.wheelMeshes) for (let w = 0; w < 4; w++) im.setMatrixAt(i * 4 + w, zero);
        t.paint.setColorAt(i, d.meta.livery ? _c.set(0xffffff) : _c.set(PAINTS[(i * 7 + ti * 3) % PAINTS.length]));
        t.lightF?.setColorAt(i, _c.setRGB(0.5, 0.5, 0.5));
        t.lightR?.setColorAt(i, _c.setRGB(0.4, 0.02, 0.02));
      }
      for (const im of [...t.partList, ...t.wheelMeshes]) {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
      return t;
    });

    // ---- parked cars: static, chunk-culled instances. Imported model up close, procedural body beyond,
    // cross-dissolved (fadeMaterial fade-out / fade-in on the same dither) ----
    const IB = new InstanceBatches(scene, cull, 400);
    // the detailed models get small chunks: chunk culling draws whole chunks, and 400 m of parked models was ~6 M triangles
    const IBN = new InstanceBatches(scene, cull, 80);
    const NEAR = 95;
    const nearOpt = { maxDist: NEAR, cast: true }, nearThin = { maxDist: NEAR, cast: false }, farOpt = { maxDist: 220, cast: !useKits, fadeIn: useKits ? NEAR : 0 }; // far bodies start beyond the ±75 m shadow map: casting only cost shadow-pass triangles
    const parkTypes = defs.map((d, ti) => ti).filter((ti) => defs[ti].meta.parked !== false);
    const white = new THREE.Color(0xffffff);
    for (const p of parked) {
      const ti = useKits ? parkTypes[(Math.floor(p.color * 997) + p.variant) % parkTypes.length] : p.variant % defs.length;
      const t = this.types[ti], d = defs[ti];
      _e.set(0, p.rot, 0, 'YXZ'); _q.setFromEuler(_e);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), _q, new THREE.Vector3(1, 1, 1));
      const paintCol = new THREE.Color(PAINTS[Math.floor(p.color * PAINTS.length)]);
      const col = d.meta.livery ? white : paintCol;
      const handles = [];
      const wheelAt = (wd, r) => {
        _e.set(0, wd.x < 0 ? Math.PI : 0, 0, 'YXZ'); _q.setFromEuler(_e);
        return new THREE.Matrix4().compose(new THREE.Vector3(wd.x, r, wd.z), _q, new THREE.Vector3(1, 1, 1)).premultiply(m);
      };
      if (useKits) {
        for (const pp of t.parkedParts) {
          IBN.define(pp.name, pp.geo, pp.mat, pp.paint ? nearOpt : nearThin); // one shadow caster per parked car
          handles.push([IBN, IBN.add(pp.name, m, pp.paint ? col : null)]);
        }
        for (const wd of t.wheels) { IBN.define(d.key + ':wheel', d.kit.wheel.geo, d.kit.wheel.material, nearThin); handles.push([IBN, IBN.add(d.key + ':wheel', wheelAt(wd, t.params.r))]); }
      }
      // procedural far body (or the only body without kits)
      const farName = d.meta.far, gl = proc(farName, 2), gp = proc(farName, 1);
      const farCol = d.meta.farColor != null ? new THREE.Color(d.meta.farColor) : paintCol;
      IB.define('far:' + farName + ':paint', gl.geo.paint, M.npcPaint, farOpt); handles.push([IB, IB.add('far:' + farName + ':paint', m, farCol)]);
      IB.define('far:' + farName + ':glass', gl.geo.glass, M.npcGlass, farOpt); handles.push([IB, IB.add('far:' + farName + ':glass', m)]);
      IB.define('far:' + farName + ':trim', gl.geo.trim, M.trim, farOpt); handles.push([IB, IB.add('far:' + farName + ':trim', m)]);
      for (const wd of gp.wheels) { IB.define('far:' + farName + ':tire', gl.geo.tire, M.tire, farOpt); handles.push([IB, IB.add('far:' + farName + ':tire', wheelAt(wd, gp.params.r))]); }
      const P = t.params, hy = Math.max(0.4, (P.H - 0.3) / 2);
      const dsc = RAPIER.ColliderDesc.roundCuboid(P.W / 2 - 0.15, hy, P.L / 2 - 0.15, 0.1)
        .setTranslation(p.x, p.y + 0.3 + hy, p.z)
        .setRotation({ x: 0, y: Math.sin(p.rot / 2), z: 0, w: Math.cos(p.rot / 2) })
        .setFriction(0.35).setCollisionGroups(GROUPS.npc);
      const c = registerStatic(world.createCollider(dsc), p.x, p.z, 3);
      const rec = { ti, p, color: col, handles, collider: c, converted: false };
      this.parkedOwner.set(c.handle, rec);
    }
    IB.build();
    IBN.build();
    this.parkedIB = IB;

    // ---- pooled NPC cars ----
    this.cars = [];
    const slots = defs.map(() => 0);
    for (let i = 0; i < maxCars; i++) {
      const ti = assign[i];
      const type = this.types[ti];
      const slot = slots[ti]++;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -60 - i * 4, 0)
        .setLinearDamping(0.05).setAngularDamping(0.6).setCcdEnabled(false)); // CCD only while wrecked (see wreck): ~11% of each physics step for 48 kinematic cars
      const P = type.params;
      const hx = P.W / 2 - 0.05, hz = P.L / 2 - 0.05, hy = Math.max(0.45, (P.H - 0.3) / 2 + 0.05);
      const mass = clamp(1350 * (P.L * P.W * P.H) / (4.6 * 1.8 * 1.4), 1100, 4500);
      const chassis = world.createCollider(RAPIER.ColliderDesc.roundCuboid(hx - 0.1, hy - 0.1, hz - 0.1, 0.1).setTranslation(0, 0.25 + hy, 0)
        .setMassProperties(mass, { x: 0, y: -0.25, z: 0 }, { x: mass / 12 * (4 * hy * hy + 4 * hz * hz), y: mass / 12 * (4 * hx * hx + 4 * hz * hz), z: mass / 12 * (4 * hx * hx + 4 * hy * hy) }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.3).setRestitution(0.05).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setCollisionGroups(GROUPS.npc), body);
      // wheel spheres: frictionless contact with the road; grip is applied by wreckStep()
      for (const wd of type.wheels) {
        world.createCollider(RAPIER.ColliderDesc.ball(P.r).setTranslation(wd.x, P.r, wd.z).setDensity(0).setFriction(0)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setCollisionGroups(groups(G.NPC, G.WORLD)), body);
      }
      this.cars.push({
        id: i, type, slot, body, active: false, path: null, next: null, s: 0, v: 0, hint: 0,
        v0: 12, T: 1.3, a: 1.6, b: 2.6, s0: 2.4, len: P.L,
        pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), heading: 0, pitch: 0, spin: 0, brake: false,
        stopTimer: 0, clearedStop: -1, stuck: 0, lat: Math.random() * 6.28, honkTimer: 0,
        state: 'drive', quat: new THREE.Quaternion(), wreckT: 0, chassis,
      });
      this.carOwner.set(chassis.handle, this.cars[this.cars.length - 1]);
    }
    // index paths usable for spawning
    this.spawnPaths = layout.paths.filter((p) => p.kind !== 'connector');
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.signalTimer = 0;
  }

  writeCar(t, idx, x, y, z, heading, pitch, spin, steer = 0, quat = null) {
    if (quat) _q.copy(quat);
    else { _e.set(pitch, heading, 0, 'YXZ'); _q.setFromEuler(_e); }
    _m.compose(_p.set(x, y, z), _q, _s.set(1, 1, 1));
    for (const im of t.partList) im.setMatrixAt(idx, _m);
    const P = t.params;
    for (let w = 0; w < 4; w++) {
      const wd = t.wheels[w];
      const flip = wd.x < 0;
      _e.set(flip ? -spin : spin, (wd.front ? steer : 0) + (flip ? Math.PI : 0), 0, 'YXZ');
      _q.setFromEuler(_e);
      _w.compose(_p.set(wd.x, P.r, wd.z), _q, _s);
      _w.premultiply(_m);
      for (const im of t.wheelMeshes) im.setMatrixAt(idx * 4 + w, _w);
    }
  }

  hideCar(car) {
    const t = car.type, idx = car.slot;
    const zero = _m.makeScale(0, 0, 0);
    for (const im of t.partList) im.setMatrixAt(idx, zero);
    for (const im of t.wheelMeshes) for (let w = 0; w < 4; w++) im.setMatrixAt(idx * 4 + w, zero);
    if (car.state === 'wreck') this.unwreck(car);
    car.body.setNextKinematicTranslation({ x: 0, y: -60 - car.id * 4, z: 0 });
  }

  // ------------------------------------------------------------------ wrecks
  /** Turn a pooled traffic car into a dynamic rigid body (it was, or is about to be, hit). */
  wreck(car) {
    if (car.state === 'wreck') return;
    const R = this.R, b = car.body;
    _q.setFromEuler(_e.set(car.pitch, car.heading, 0, 'YXZ'));
    b.setBodyType(R.RigidBodyType.Dynamic, true);
    b.setTranslation({ x: car.pos.x, y: car.pos.y, z: car.pos.z }, true);
    b.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    b.setLinvel({ x: car.fwd.x * car.v, y: 0, z: car.fwd.z * car.v }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.enableCcd(true); // a hit car can be thrown fast enough to tunnel through thin props
    car.state = 'wreck';
    car.wreckT = 0;
    car.quat.copy(_q);
    this.onWreck?.(car);
  }

  unwreck(car) {
    const b = car.body;
    b.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.setBodyType(this.R.RigidBodyType.KinematicPositionBased, false);
    b.enableCcd(false);
    b.setTranslation({ x: 0, y: -60 - car.id * 4, z: 0 }, false);
    car.state = 'drive';
  }

  /** A parked car is about to be hit: hide its static instance and swap in a pooled dynamic car. */
  convertParked(rec, player) {
    if (rec.converted) return null;
    const ti = rec.ti;
    let car = this.cars.find((c) => c.type === this.types[ti] && !c.active);
    if (!car) {
      const cands = this.cars.filter((c) => c.type === this.types[ti] && c.state !== 'wreck');
      cands.sort((a, b) => b.pos.distanceToSquared(player) - a.pos.distanceToSquared(player));
      car = cands[0];
      if (!car) return null;
      this.hideCar(car);
    }
    rec.converted = true;
    for (const [ib, h] of rec.handles) ib.hide(h);
    this.retire(rec.collider);
    car.active = true;
    car.path = null; car.next = null; car.v = 0;
    car.pos.set(rec.p.x, rec.p.y, rec.p.z);
    car.heading = rec.p.rot; car.pitch = 0;
    car.fwd.set(Math.sin(car.heading), 0, Math.cos(car.heading));
    car.type.paint.setColorAt(car.slot, rec.color);
    car.type.paint.instanceColor.needsUpdate = true;
    this.wreck(car);
    car.parked = true;
    return car;
  }

  /** Simplified tyre model for wrecked cars: lateral grip, braking, yaw damping; frictionless wheel spheres. */
  wreckStep(car, dt) {
    const b = car.body;
    const t = b.translation(), r = b.rotation(), lv = b.linvel(), av = b.angvel();
    car.pos.set(t.x, t.y, t.z);
    car.quat.set(r.x, r.y, r.z, r.w);
    const up = _p.set(0, 1, 0).applyQuaternion(car.quat);
    const fwd = _w0.set(0, 0, 1).applyQuaternion(car.quat);
    car.fwd.set(fwd.x, 0, fwd.z).normalize();
    car.heading = Math.atan2(car.fwd.x, car.fwd.z);
    const speed = Math.hypot(lv.x, lv.z);
    car.v = speed;
    if (up.y > 0.6) {
      this.ray.origin.x = t.x; this.ray.origin.y = t.y + 0.6; this.ray.origin.z = t.z;
      const hit = this.world.castRay(this.ray, 1.2, true, undefined, GROUPS.wheelRay, undefined, b);
      if (hit) {
        const m = b.mass();
        const fx = car.fwd.x, fz = car.fwd.z, rx = fz, rz = -fx;
        const vLong = lv.x * fx + lv.z * fz, vLat = lv.x * rx + lv.z * rz;
        const latMax = 8.0 * dt, longMax = (car.parked ? 9 : 5.5) * dt;
        const dLat = clamp(-vLat, -latMax, latMax), dLong = clamp(-vLong, -longMax, longMax);
        b.applyImpulse({ x: (rx * dLat + fx * dLong) * m, y: 0, z: (rz * dLat + fz * dLong) * m }, true);
        b.setAngvel({ x: av.x, y: av.y * (1 - Math.min(1, 2.2 * dt)), z: av.z }, true);
      }
    }
    car.spin += (car.v / car.type.params.r) * dt * 0.5;
    car.wreckT += dt;
    // a sliding wreck collects any traffic it slams into
    if (speed > 3) {
      for (const o of this.cars) {
        if (o === car || !o.active || o.state === 'wreck') continue;
        if (o.pos.distanceToSquared(car.pos) < 7.5) this.wreck(o);
      }
    }
  }

  spawn(car, player, camera) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const p = this.spawnPaths[Math.floor(Math.random() * this.spawnPaths.length)];
      const s = Math.random() * p.len;
      pointAt(p, s, _p);
      const d = Math.hypot(_p.x - player.x, _p.z - player.z);
      if (d < 90 || d > 420) continue;
      if (camera) {
        const cx = _p.x - camera.position.x, cz = _p.z - camera.position.z;
        const dir = camera.getWorldDirection(_w0);
        if ((cx * dir.x + cz * dir.z) / Math.hypot(cx, cz) > 0.35 && d < 220) continue; // avoid popping in view
      }
      let clear = true;
      for (const o of this.cars) if (o.active && o.pos.distanceToSquared(_p) < 18 * 18) { clear = false; break; }
      if (!clear) continue;
      car.active = true;
      car.path = p; car.s = s; car.hint = 0;
      car.next = this.pickNext(p);
      car.v = Math.min(p.speed, 8 + Math.random() * 6);
      const fast = p.kind === 'ring';
      car.v0 = (fast ? 24 : 13) * (0.82 + Math.random() * 0.3);
      car.T = 1.1 + Math.random() * 0.7;
      car.a = 1.3 + Math.random() * 1.0;
      car.b = 2.4 + Math.random() * 0.8;
      car.s0 = 2.0 + Math.random() * 1.2;
      car.speedFactor = 0.85 + Math.random() * 0.25;
      car.stopTimer = 0; car.clearedStop = -1; car.stuck = 0; car.parked = false;
      car.pos.copy(_p);
      const ah = new THREE.Vector3();
      pointAt(p, Math.min(p.len, s + 2), ah);
      if (ah.distanceToSquared(_p) > 0.01) car.heading = Math.atan2(ah.x - _p.x, ah.z - _p.z);
      car.fwd.set(Math.sin(car.heading), 0, Math.cos(car.heading));
      return true;
    }
    return false;
  }

  pickNext(path) {
    const n = path.next;
    if (!n.length) return null;
    if (n.length === 1) return this.L.paths[n[0]];
    const weights = n.map((id) => { const p = this.L.paths[id]; return p.turn === 'S' ? 0.6 : 0.2; });
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n.length; i++) { r -= weights[i]; if (r <= 0) return this.L.paths[n[i]]; }
    return this.L.paths[n[n.length - 1]];
  }

  setDensity(limit) { this.activeLimit = clamp(Math.round(limit), 0, this.maxCars); }

  /** Fixed-step simulation. player: {pos, vel(Vector3)} */
  fixedUpdate(dt, player, camera) {
    this.time += dt;
    const L = this.L;
    let active = 0;
    // which cars are inside each intersection (on a connector), and where they came from
    const occ = new Map();
    for (const car of this.cars) {
      if (!car.active) continue;
      active++;
      const p = car.path;
      if (p && p.kind === 'connector' && p.inter >= 0) {
        if (!occ.has(p.inter)) occ.set(p.inter, []);
        occ.get(p.inter).push(car);
      }
    }
    for (const car of this.cars) {
      if (!car.active) {
        if (active < this.activeLimit && Math.random() < 0.02) { if (this.spawn(car, player.pos, camera)) active++; }
        continue;
      }
      const dPlayer = Math.hypot(car.pos.x - player.pos.x, car.pos.z - player.pos.z);
      if (car.state === 'wreck') {
        this.wreckStep(car, dt);
        if ((car.wreckT > 30 && dPlayer > 80) || dPlayer > 300 || car.pos.y < -20) { car.active = false; car.parked = false; this.hideCar(car); active--; }
        continue;
      }
      if (car.id >= this.activeLimit + 2 && Math.random() < 0.01) { car.active = false; this.hideCar(car); active--; continue; }
      if (dPlayer > 470 || (car.stuck > 30 && dPlayer > 80)) { car.active = false; this.hideCar(car); active--; continue; }

      // ---- leader detection ----
      let gap = 1e9, leadV = 0;
      const fx = car.fwd.x, fz = car.fwd.z;
      for (const o of this.cars) {
        if (o === car || !o.active) continue;
        const rx = o.pos.x - car.pos.x, rz = o.pos.z - car.pos.z;
        const along = rx * fx + rz * fz;
        if (along <= 0 || along > 45) continue;
        const lat = Math.abs(rx * fz - rz * fx);
        if (lat > 2.0 || Math.abs(o.pos.y - car.pos.y) > 3) continue;
        const dot = o.fwd.x * fx + o.fwd.z * fz;
        if (dot < -0.3) continue;
        const g = along - (car.len + o.len) / 2;
        if (g < gap) { gap = g; leadV = o.v * Math.max(0, dot); }
      }
      {
        const rx = player.pos.x - car.pos.x, rz = player.pos.z - car.pos.z;
        const along = rx * fx + rz * fz, lat = Math.abs(rx * fz - rz * fx);
        if (along > 0 && along < 40 && lat < 2.4 && Math.abs(player.pos.y - car.pos.y) < 3) {
          const g = along - (car.len + 4.5) / 2;
          if (g < gap) { gap = g; leadV = Math.max(0, player.vel.x * fx + player.vel.z * fz); }
          if (g < 6 && car.v < 1 && player.vel.length() < 1) {
            car.honkTimer += dt;
            if (car.honkTimer > 2.5) { car.honkTimer = -4 - Math.random() * 6; this.onHonk?.(car.pos); }
          }
        }
      }
      // ---- signals / stop signs ----
      const path = car.path;
      if (path.kind === 'lane' && path.endInter >= 0) {
        const I = L.intersections[path.endInter];
        const toEnd = path.len - car.s;
        // yield to vehicles already crossing the intersection from another approach
        const inside = occ.get(path.endInter);
        if (inside && toEnd < 8) {
          const d = path.dir;
          for (const o of inside) {
            const od = o.prevDir;
            if (od && (od[0] !== d[0] || od[2] !== d[2])) { const g = toEnd - 0.8; if (g < gap) { gap = g; leadV = 0; } break; }
          }
        }
        if (toEnd < 60) {
          if (I.type === 'signal') {
            const st = signalState(I, path.axis, this.time);
            const mustStop = st === 'red' || (st === 'yellow' && toEnd > car.v * 1.3 + 2);
            if (mustStop && toEnd > -0.5) { const g = toEnd - 0.8; if (g < gap) { gap = g; leadV = 0; } }
          } else if (car.clearedStop !== path.id) {
            const g = toEnd - 0.6;
            if (g < gap) { gap = g; leadV = 0; }
            if (toEnd < car.s0 + 2.2 && car.v < 0.4) {
              car.stopTimer += dt;
              if (car.stopTimer > 1.1 + Math.random() * 0.02) { car.clearedStop = path.id; car.stopTimer = 0; }
            }
          }
        }
      }
      // ---- IDM ----
      const vDes = Math.max(3, Math.min(car.v0, path.speed * car.speedFactor * (path.kind === 'ring' ? 1.1 : 1)));
      const v = car.v;
      const sStar = car.s0 + v * car.T + (v * (v - leadV)) / (2 * Math.sqrt(car.a * car.b));
      const g = Math.max(0.1, gap);
      let acc = car.a * (1 - Math.pow(v / vDes, 4) - (sStar / g) * (sStar / g));
      acc = clamp(acc, -9, car.a);
      car.acc = acc;
      car.v = Math.max(0, v + acc * dt);
      car.s += car.v * dt;
      car.stuck = car.v < 0.1 ? car.stuck + dt : 0;
      // ---- path transitions ----
      while (car.s > car.path.len) {
        car.s -= car.path.len;
        if (!car.next) { car.active = false; this.hideCar(car); break; }
        if (car.path.dir) car.prevDir = car.path.dir;
        car.path = car.next;
        car.hint = 0;
        car.next = this.pickNext(car.path);
      }
      if (!car.active) { active--; continue; }
      // ---- pose ----
      car.hint = pointAt(car.path, car.s, car.pos, car.hint);
      const look = car.s + 3.0;
      const ahead = _ahead;
      if (look <= car.path.len || !car.next) pointAt(car.path, look, ahead);
      else pointAt(car.next, look - car.path.len, ahead);
      const behind = _behind;
      pointAt(car.path, Math.max(0, car.s - 1.5), behind);
      const dx = ahead.x - car.pos.x, dz = ahead.z - car.pos.z;
      const hl = Math.hypot(dx, dz);
      if (hl > 0.05) {
        const target = Math.atan2(dx, dz);
        let dh = target - car.heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        car.steer = clamp(dh * 2, -0.5, 0.5);
        car.heading += dh * Math.min(1, dt * 10);
        car.fwd.set(Math.sin(car.heading), 0, Math.cos(car.heading));
      }
      car.pitch = -Math.atan2(ahead.y - behind.y, Math.max(1, Math.hypot(ahead.x - behind.x, ahead.z - behind.z)));
      car.lat += dt * 0.25;
      const latOff = Math.sin(car.lat) * 0.12;
      car.pos.x += car.fwd.z * latOff; car.pos.z -= car.fwd.x * latOff;
      car.spin += (car.v / car.type.params.r) * dt;
      car.brake = acc < -1.2 || car.v < 0.2;
      _q.setFromEuler(_e.set(car.pitch, car.heading, 0, 'YXZ'));
      car.body.setNextKinematicTranslation({ x: car.pos.x, y: car.pos.y, z: car.pos.z });
      car.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
    this.activeCount = active;
  }

  /** Per-frame visual update (instance matrices, lights, signal lamps). */
  update(dt, nightLights, signalLamps, lampInstances) {
    for (const t of this.types) t.used = 0;
    for (const car of this.cars) {
      if (!car.active) continue;
      const t = car.type;
      t.used = Math.max(t.used, car.slot + 1);
      const wrecked = car.state === 'wreck';
      this.writeCar(t, car.slot, car.pos.x, car.pos.y, car.pos.z, car.heading, car.pitch, car.spin, wrecked ? 0 : car.steer || 0, wrecked ? car.quat : null);
      const hazard = wrecked && (this.time % 0.9) < 0.45;
      const f = 0.4 + nightLights * 7;
      t.lightF.setColorAt(car.slot, hazard ? _c.setRGB(6, 2.6, 0.2) : _c.setRGB(f, f, f * 0.92));
      const r = hazard ? 6 : car.brake ? 7 : 0.35 + nightLights * 1.6;
      t.lightR.setColorAt(car.slot, _c.setRGB(r, r * 0.03, r * 0.02));
    }
    // draw only the slots in use (instances past `used` are skipped entirely) and skip idle body types:
    // every part is its own draw call, and with 8 imported models most types are often idle
    for (const t of this.types) {
      const on = t.used > 0;
      for (const im of t.partList) { im.visible = on; im.count = t.used; if (on) im.instanceMatrix.needsUpdate = true; }
      for (const im of t.wheelMeshes) { im.visible = on; im.count = t.used * 4; if (on) im.instanceMatrix.needsUpdate = true; }
      if (on) { t.lightF.instanceColor.needsUpdate = true; t.lightR.instanceColor.needsUpdate = true; }
    }
    // traffic light lamps
    this.signalTimer -= dt;
    if (signalLamps && this.signalTimer <= 0) {
      this.signalTimer = 0.1;
      const ON = [[7, 0.35, 0.2], [7, 3.6, 0.25], [0.2, 6, 2.2]];
      const OFF = [[0.08, 0.015, 0.01], [0.08, 0.05, 0.01], [0.01, 0.06, 0.03]];
      lampInstances.forEach((li, i) => {
        const I = this.L.intersections[li.inter];
        const st = signalState(I, li.axis, this.time);
        const on = (st === 'red' && li.k === 0) || (st === 'yellow' && li.k === 1) || (st === 'green' && li.k === 2);
        const c = on ? ON[li.k] : OFF[li.k];
        signalLamps.setColorAt(i, _c.setRGB(c[0], c[1], c[2]));
      });
      signalLamps.instanceColor.needsUpdate = true;
    }
  }

  /** Nearest active NPC cars for spatial audio. */
  nearest(pos, n) {
    const best = this._nearest || (this._nearest = []);
    best.length = 0;
    for (const c of this.cars) {
      if (!c.active) continue;
      const d = c.pos.distanceToSquared(pos);
      if (best.length < n) { best.push(c); c._d = d; best.sort((a, b) => a._d - b._d); }
      else if (d < best[n - 1]._d) { c._d = d; best[n - 1] = c; best.sort((a, b) => a._d - b._d); }
    }
    return best;
  }
}
