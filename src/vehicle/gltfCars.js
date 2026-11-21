// Imported car models (CC-BY, Daniel Zhabotinsky — see public/assets/cars/CREDITS.txt).
// Each glTF is normalised into the game's car frame (+Z forward, +Y up, +X left, origin on the ground between
// the axles) and split into the same material slots the procedural cars use: paint (instance-coloured, or a
// livery texture), glass, front / rear lights, textured body parts and one wheel template. The player car gets
// the full model, traffic and parked cars a simplified one (`<key>_lod.gltf`, built offline with meshoptimizer).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createPlayerCar } from './carModel.js';

const BASE = 'assets/cars/';

/** Traffic mix (weights) and the procedural body used as the far LOD / fallback for each model. */
export const CAR_MODELS = {
  taxi: { name: "Canyon '75 Taxi", weight: 0.2, far: 'sedan', farColor: 0xd9a21b, livery: true },
  kiri: { name: "Kiri '86", weight: 0.14, far: 'hatch' },
  fairheaven: { name: "Fairheaven LT '80", weight: 0.14, far: 'sedan' },
  riverside: { name: "Riverside '88", weight: 0.14, far: 'sedan' },
  wagon: { name: "Fairheaven SW '84", weight: 0.12, far: 'suv' },
  van: { name: "Shvan '92", weight: 0.1, far: 'van' },
  truck: { name: "LCT 3000 '07", weight: 0.09, far: 'van', parked: false },
  cop: { name: "Fairheaven LT '80 Cop Cruiser", weight: 0.07, far: 'sedan', farColor: 0x1a1c20, livery: true, parked: false },
};

/** Player body types (career cars) drawn with an imported model. The sport car keeps its procedural body. */
export const PLAYER_MODELS = { hatch: 'kiri', sedan: 'riverside', suv: 'wagon' };

const KITS = { full: {}, lod: {} };
export const getKit = (key, lod = 'lod') => KITS[lod][key] || null;
export const kitForType = (type) => (PLAYER_MODELS[type] && KITS.full[PLAYER_MODELS[type]]) || null;

function classify(path, mat) {
  const mn = mat?.name || '';
  const transparent = /Transperent|Transparent/i.test(mn);
  if (/Wheel/i.test(path) && /Tire/i.test(mn)) return 'wheel';
  if (transparent) {
    if (/Head_?lights?_?Glass|Tail_?lights?_?Glass/i.test(path)) return 'skip'; // light covers: the lamps show through
    if (/Lightbar/i.test(path)) return 'body';
    return 'glass';
  }
  if (/Head_?light/i.test(path)) return 'lightF';
  if (/Brake_?light|Tail_?light/i.test(path)) return 'lightR';
  if (/Blinker|Indicator/i.test(path)) return 'indicator';
  if (/Reverse/i.test(path)) return 'reverse';
  if (/bodymat/i.test(mn)) return 'paint';
  return 'body';
}

function cleanGeometry(g) {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g.index ? g.toNonIndexed() : g;
}

/** Build a kit from a loaded glTF scene. */
function buildKit(key, scene) {
  scene.updateMatrixWorld(true);
  const meshes = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let path = '', p = o;
    while (p) { path = p.name + '/' + path; p = p.parent; }
    meshes.push({ mesh: o, path, slot: classify(path, o.material) });
  });
  // bounds and orientation in the file's frame
  const box = new THREE.Box3(), tmp = new THREE.Box3(), lights = new THREE.Vector3();
  let nl = 0;
  for (const m of meshes) {
    if (m.slot === 'skip') continue;
    tmp.setFromObject(m.mesh);
    box.union(tmp);
    if (m.slot === 'lightF') { lights.add(tmp.getCenter(new THREE.Vector3())); nl++; }
  }
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  if (nl) lights.divideScalar(nl);
  const alongX = size.x > size.z;
  const front = nl ? Math.sign(alongX ? lights.x - centre.x : lights.z - centre.z) || 1 : 1;
  const yaw = alongX ? (front > 0 ? -Math.PI / 2 : Math.PI / 2) : (front > 0 ? 0 : Math.PI);
  const length = alongX ? size.x : size.z;
  const scale = length > 2.5 && length < 9 ? 1 : 4.6 / length; // these files are in metres; guard odd exports
  // car frame: centre on the wheelbase midpoint, ground at the tyre bottoms
  const N = new THREE.Matrix4().makeRotationY(yaw).scale(new THREE.Vector3(scale, scale, scale))
    .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z));
  const wheelInfo = [];
  for (const m of meshes) if (m.slot === 'wheel') {
    tmp.setFromObject(m.mesh).applyMatrix4(N);
    wheelInfo.push({ m, c: tmp.getCenter(new THREE.Vector3()), s: tmp.getSize(new THREE.Vector3()) });
  }
  // shift along Z so the wheelbase is centred, and drop to the tyre bottoms
  let dz = 0, dy = 0;
  if (wheelInfo.length >= 4) {
    const zs = wheelInfo.map((w) => w.c.z);
    dz = -(Math.max(...zs) + Math.min(...zs)) / 2;
    dy = -Math.min(...wheelInfo.map((w) => w.c.y - w.s.y / 2));
    N.premultiply(new THREE.Matrix4().makeTranslation(0, dy, dz));
    for (const w of wheelInfo) w.c.add(new THREE.Vector3(0, dy, dz));
  }

  const slots = {};
  const add = (slot, mat, geo) => {
    const k = slot === 'body' ? 'body:' + (mat.name || mat.uuid) : slot;
    (slots[k] ||= { slot, material: mat, list: [] }).list.push(geo);
  };
  let steering = null;
  for (const m of meshes) {
    if (m.slot === 'skip' || m.slot === 'wheel') continue;
    const g = cleanGeometry(m.mesh.geometry.clone()).applyMatrix4(new THREE.Matrix4().multiplyMatrices(N, m.mesh.matrixWorld));
    if (/Steering/i.test(m.path)) { steering = { geo: g, material: m.mesh.material }; continue; }
    add(m.slot, m.mesh.material, g);
  }
  const parts = {};
  for (const [k, s] of Object.entries(slots)) parts[k] = { slot: s.slot, material: s.material, geo: mergeGeometries(s.list) };

  // wheels: positions from all four, geometry from the front-left one (outer face toward +X)
  let wheels = [], wheel = null, r = 0.33;
  if (wheelInfo.length >= 4) {
    r = Math.max(...wheelInfo.map((w) => w.s.y)) / 2;
    const fl = wheelInfo.reduce((best, w) => (w.c.x > 0 && w.c.z > 0 && (!best || w.c.z > best.c.z) ? w : best), null) || wheelInfo[0];
    const g = cleanGeometry(fl.m.mesh.geometry.clone()).applyMatrix4(new THREE.Matrix4().multiplyMatrices(N, fl.m.mesh.matrixWorld));
    g.translate(-fl.c.x, -fl.c.y, -fl.c.z);
    wheel = { geo: g, material: fl.m.mesh.material };
    const sorted = [...wheelInfo].sort((a, b) => b.c.z - a.c.z);
    const frontZ = (sorted[0].c.z + sorted[1].c.z) / 2, rearZ = (sorted[2].c.z + sorted[3].c.z) / 2;
    const x = wheelInfo.reduce((s, w) => s + Math.abs(w.c.x), 0) / wheelInfo.length;
    // order matches vehicleSpec: front-left, front-right, rear-left, rear-right (+X is left)
    wheels = [{ x, z: frontZ, front: true }, { x: -x, z: frontZ, front: true }, { x, z: rearZ, front: false }, { x: -x, z: rearZ, front: false }];
  }
  const fb = new THREE.Box3();
  for (const p of Object.values(parts)) { p.geo.computeBoundingBox(); fb.union(p.geo.boundingBox); }
  const headlights = [];
  if (parts.lightF) {
    const pos = parts.lightF.geo.attributes.position;
    for (const side of [1, -1]) {
      const c = new THREE.Vector3(); let n = 0;
      for (let i = 0; i < pos.count; i++) if (Math.sign(pos.getX(i)) === side) { c.x += pos.getX(i); c.y += pos.getY(i); c.z += pos.getZ(i); n++; }
      if (n) headlights.push(c.divideScalar(n).add(new THREE.Vector3(0, 0, 0.05)));
    }
  }
  if (headlights.length < 2) headlights.splice(0, 2, new THREE.Vector3(0.6, 0.7, fb.max.z), new THREE.Vector3(-0.6, 0.7, fb.max.z));
  const params = {
    key, L: fb.max.z - fb.min.z, W: fb.max.x - fb.min.x, H: fb.max.y, r, wheels,
    wf: wheels[0]?.z ?? 1.3, wr: wheels[2]?.z ?? -1.3, front: fb.max.z, rear: fb.min.z,
    roofY: fb.max.y, clearance: 0.16, belt: fb.max.y * 0.68,
  };
  return { key, params, parts, wheel, steering, headlights };
}

/** Load every model (full + traffic LOD). Resolves with false when the assets are missing. */
export async function loadCarKits(maxAniso = 8) {
  const loader = new GLTFLoader();
  const jobs = [];
  for (const key of Object.keys(CAR_MODELS)) {
    for (const lod of ['full', 'lod']) {
      if (lod === 'full' && !Object.values(PLAYER_MODELS).includes(key)) continue;
      jobs.push(loader.loadAsync(`${BASE}${key}/${key}${lod === 'lod' ? '_lod' : ''}.gltf`).then((gltf) => {
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          for (const t of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (o.material[t]) o.material[t].anisotropy = Math.min(maxAniso, 4);
        });
        KITS[lod][key] = buildKit(key, gltf.scene);
      }));
    }
  }
  await Promise.all(jobs);
  return KITS;
}

/** Body dimensions for vehicleSpec(): physics wheel positions follow the model. */
export function bodyOverride(type) {
  const kit = kitForType(type);
  if (!kit || kit.params.wheels.length < 4) return null;
  const P = kit.params;
  return { W: 2 * (P.wheels[0].x + 0.16), L: P.L, r: P.r, wf: P.wf, wr: P.wr, roofY: P.H };
}

// ------------------------------------------------------------------------------------------------
// Player car from a kit: same interface as carModel.createPlayerCar (root, wheels, materials, ...).
// ------------------------------------------------------------------------------------------------
function dummyScreen() {
  const c = document.createElement('canvas'); c.width = c.height = 2;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }));
  m.visible = false;
  return m;
}

function lampMaterial(src, color) {
  const m = src.clone();
  m.emissive = new THREE.Color(color);
  m.emissiveMap = src.map || null;
  m.emissiveIntensity = 0;
  m.transparent = false;
  return m;
}

export function createModelCar(M, kit) {
  const root = new THREE.Group();
  root.name = 'playerCar';
  const body = new THREE.Group();
  root.add(body);
  const P = kit.params;
  const paint = M.paint.clone();
  const livery = kit.parts.paint?.material?.map;
  if (kit.parts.paint?.material?.normalMap) { paint.normalMap = kit.parts.paint.material.normalMap; paint.normalScale = new THREE.Vector2(1, 1); }
  const glass = M.carGlass.clone();
  glass.forceSinglePass = true;
  glass.envMapIntensity = 0.7;
  const lampSrc = (kit.parts.lightF || kit.parts.lightR || kit.parts.indicator)?.material || new THREE.MeshStandardMaterial();
  const headLens = lampMaterial(kit.parts.lightF?.material || lampSrc, 0xfff6ea);
  const tail = lampMaterial(kit.parts.lightR?.material || lampSrc, 0xff2a14);
  const indicator = lampMaterial(kit.parts.indicator?.material || lampSrc, 0xff8a00);
  const reverse = lampMaterial(kit.parts.reverse?.material || lampSrc, 0xffffff);
  const drl = M.drl.clone();
  const interior = M.interior.clone(), leather = M.leather.clone();
  interior.emissiveIntensity = leather.emissiveIntensity = 0;
  const own = { paint: livery ? kit.parts.paint.material.clone() : paint, glass, lightF: headLens, lightR: tail, indicator, reverse };
  const bodyMats = [];
  for (const [k, p] of Object.entries(kit.parts)) {
    let mat = own[p.slot];
    if (!mat) {
      mat = p.material.clone();
      if (mat.transparent) { mat.transparent = false; mat.alphaTest = 0.5; }
      bodyMats.push(mat);
    }
    const mesh = new THREE.Mesh(p.geo.clone(), mat);
    mesh.castShadow = p.slot === 'paint' || p.slot === 'body';
    mesh.receiveShadow = true;
    if (p.slot === 'glass') mesh.renderOrder = 2;
    mesh.name = k;
    body.add(mesh);
  }
  // steering wheel (spins about its own column)
  const steering = new THREE.Group();
  if (kit.steering) {
    const g = kit.steering.geo.clone();
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new THREE.Vector3());
    g.translate(-c.x, -c.y, -c.z);
    const pivot = new THREE.Group();
    pivot.position.copy(c);
    pivot.rotation.x = -0.35;
    const sm = new THREE.Mesh(g, kit.steering.material);
    sm.rotation.x = 0.35;
    steering.add(sm);
    pivot.add(steering);
    body.add(pivot);
  }
  const sw = kit.steering ? kit.steering.geo.boundingBox || (kit.steering.geo.computeBoundingBox(), kit.steering.geo.boundingBox) : null;
  const swc = sw ? sw.getCenter(new THREE.Vector3()) : new THREE.Vector3(0.38, P.H * 0.6, 0.2);
  const driverEye = new THREE.Vector3(swc.x, Math.min(P.H - 0.14, swc.y + 0.36), swc.z - 0.5);
  const rider = new THREE.Group();
  rider.visible = false;
  const wheels = P.wheels.map((w) => {
    const hub = new THREE.Group();
    hub.position.set(w.x, P.r, w.z);
    const spin = new THREE.Group();
    const flip = w.x < 0;
    const wm = new THREE.Mesh(kit.wheel.geo, kit.wheel.material);
    wm.castShadow = true; wm.receiveShadow = true;
    spin.add(wm);
    const inner = new THREE.Group();
    inner.add(spin);
    if (flip) inner.rotation.y = Math.PI;
    hub.add(inner);
    root.add(hub);
    return { hub, spin, flip, base: new THREE.Vector3(w.x, P.r, w.z) };
  });
  const cluster = dummyScreen(), navScreen = dummyScreen();
  body.add(cluster, navScreen);
  return {
    root, body, wheels, rider, steering, driverEye, params: P,
    navigation: { screen: navScreen, draw() {} }, cluster, updateCluster() {},
    materials: { paint: own.paint, glass, headLens, drl, tail, indicator, reverse, interior, leather },
    extraMaterials: bodyMats,
    headlightPos: kit.headlights,
  };
}

/** Player / showroom car: the imported model for its body type when loaded, else the procedural one. */
export function createVehicleModel(M, type, wheelWidth, electric) {
  const kit = kitForType(type);
  return kit ? createModelCar(M, kit) : createPlayerCar(M, type, wheelWidth, electric);
}
