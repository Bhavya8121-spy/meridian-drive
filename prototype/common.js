// Shared, renderer-agnostic parts of the WebGPU prototype: the scene content (from the pure-data city layout),
// the fixed camera path, chunked instancing and distance culling. The scene is built twice from the same data,
// once with three's classic WebGLRenderer and once with WebGPURenderer, by passing in the THREE namespace and a
// small material factory; only the materials differ (GLSL onBeforeCompile patch vs TSL node graph).
import { buildLayout, CITY, RING } from '../src/world/layout.js';
import { BUILDING_STYLES, STYLE_TINTS } from '../src/render/buildingMaterial.js';
import { CAR_MODELS, loadCarKits } from '../src/vehicle/gltfCars.js';

const RES = +(new URLSearchParams(globalThis.location?.search || '').get('res') || 1);
export const WIDTH = Math.round(1600 * RES), HEIGHT = Math.round(900 * RES); // fixed drawing-buffer size for every contender (?res=2 makes it GPU-bound)
export const SHADOW_MAP = 2048, SHADOW_EXT = 75; // the game's Medium preset
export const SUN_DIR = [0.45, 0.75, 0.32];

// ---------------------------------------------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------------------------------------------
let DATA = null;
export async function loadData() {
  if (DATA) return DATA;
  const L = buildLayout(1337);
  const kits = await loadCarKits(4); // { full: {...}, lod: {...} } built with the 'three' module copy
  const hash = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
  const parkKeys = Object.keys(CAR_MODELS).filter((k) => CAR_MODELS[k].parked !== false && kits.lod[k]);
  const allKeys = Object.keys(CAR_MODELS).filter((k) => kits.lod[k]);
  const PAINT = [[0.55, 0.56, 0.58], [0.08, 0.09, 0.1], [0.75, 0.75, 0.73], [0.35, 0.08, 0.07], [0.12, 0.18, 0.3], [0.3, 0.32, 0.28], [0.6, 0.55, 0.45]];
  const cars = [];
  L.props.parkedCars.forEach((c, i) => cars.push({ kit: parkKeys[Math.floor(hash(i + 1) * parkKeys.length)], x: c.x, y: c.y || 0, z: c.z, rot: c.rot, color: PAINT[Math.floor(c.color * PAINT.length) % PAINT.length] }));
  // stand-in for moving traffic: cars on the lane graph (static here; the game moves ~24-36 of them)
  let k = 0;
  for (const p of L.paths) {
    for (let s = 12; s < p.len - 12; s += 55) {
      if (hash(p.id * 31 + s) > 0.35) continue;
      let j = 1; while (j < p.cum.length - 1 && p.cum[j] < s) j++;
      const a = p.pts[j - 1], b = p.pts[j], t = (s - p.cum[j - 1]) / Math.max(1e-3, p.cum[j] - p.cum[j - 1]);
      cars.push({ kit: allKeys[k++ % allKeys.length], x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, rot: Math.atan2(b[0] - a[0], b[2] - a[2]), color: PAINT[k % PAINT.length] });
    }
  }
  // keep the chase camera's own lanes clear (a stand-in parked on the path would sit inside the camera)
  const path = cameraPath();
  const clear = (c) => !path.some((ps) => ps.seg === 'street' && Math.hypot(c.x - ps.focus[0], c.z - ps.focus[2]) < 9);
  DATA = { L, kits, cars: cars.filter(clear), path };
  return DATA;
}

/**
 * Fixed camera path (one pose per measured frame): a chase-camera drive north up the x=0 arterial through
 * downtown, a right turn east along z=300, then a slow aerial orbit over downtown that sees the whole city.
 * Each pose: camera position, look target and a ground "focus" (where the player car and shadow frustum sit).
 */
export function cameraPath(n = 180) {
  const poses = [];
  const nDrive = Math.round(n * 0.45), nTurn = Math.round(n * 0.25), nAir = n - nDrive - nTurn;
  const chase = (fx, fz, hx, hz, seg) => {
    const l = Math.hypot(hx, hz); hx /= l; hz /= l;
    poses.push({ seg, focus: [fx, 0, fz], heading: Math.atan2(hx, hz), cam: [fx - hx * 6.2, 2.5, fz - hz * 6.2], look: [fx + hx * 12, 1.1, fz + hz * 12] });
  };
  for (let i = 0; i < nDrive; i++) { const t = i / (nDrive - 1); chase(1.9, -330 + t * 620, 0, 1, 'street'); }
  for (let i = 0; i < nTurn; i++) {
    const t = i / (nTurn - 1);
    if (t < 0.25) { const a = (t / 0.25) * Math.PI / 2; chase(1.9 + 9 - 9 * Math.cos(a), 290 + 9 * Math.sin(a), Math.sin(a), Math.cos(a), 'street'); }
    else chase(10.9 + (t - 0.25) / 0.75 * 360, 299 - 0.0, 1, 0, 'street');
  }
  for (let i = 0; i < nAir; i++) {
    const a = (i / nAir) * Math.PI * 0.9 + 0.4;
    poses.push({ seg: 'aerial', focus: [0, 0, 0], heading: 0, cam: [Math.cos(a) * 260, 140, Math.sin(a) * 260], look: [0, 10, 0] });
  }
  return poses;
}

// ---------------------------------------------------------------------------------------------------------------
// scene builder (T = the THREE namespace of the renderer being tested)
// ---------------------------------------------------------------------------------------------------------------
const chunkOf = (x, z, size) => `${Math.floor(x / size)},${Math.floor(z / size)}`;

/**
 * mats: {
 *   facade(styleName, style) -> Material,  ground(kind) -> Material,
 *   std(params) -> Material, basic(params) -> Material,  texture(srcTexture) -> T.Texture
 * }
 * opts.split: chunk-size divisor (1 = the game's 400 m building / 100 m car chunks; 2, 4 = more, smaller draws)
 */
export function buildScene(T, mats, data, opts = {}) {
  const split = opts.split || 1;
  const scene = new T.Scene();
  scene.background = new T.Color(0x9fb3c8);
  scene.fog = new T.Fog(0xa9b9c9, 250, 1900);
  const hemi = new T.HemisphereLight(0xc9d8ea, 0x5d5a52, 1.1);
  scene.add(hemi);
  const sun = new T.DirectionalLight(0xfff1dc, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -SHADOW_EXT; sc.right = sc.top = SHADOW_EXT; sc.near = 1; sc.far = 900;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const camera = new T.PerspectiveCamera(62, WIDTH / HEIGHT, 0.3, 4000);
  const chunks = []; // { obj, cx, cz, half, maxDist }
  const addChunked = (obj, key, size, maxDist) => {
    const [a, b] = key.split(',').map(Number);
    chunks.push({ obj, cx: (a + 0.5) * size, cz: (b + 0.5) * size, half: size / 2, maxDist });
    scene.add(obj);
  };
  const m4 = new T.Matrix4(), q = new T.Quaternion(), p = new T.Vector3(), s = new T.Vector3(), e = new T.Euler(), col = new T.Color();
  // three r170 WebGPU keys render objects by object.uuid only when count > 1, so a 1-instance InstancedMesh shares
  // compiled state with plain Meshes using equal material values (one of them then draws with the wrong program).
  // Pad every batch to >= 2 instances with a zero-scale one (no fragments). Done for both renderers, so it's fair.
  const instanced = (g, mat, n) => {
    const im = new T.InstancedMesh(g, mat, Math.max(2, n));
    if (n < 2) im.setMatrixAt(1, new T.Matrix4().makeScale(0, 0, 0));
    return im;
  };

  // ground + roads (world-space UVs, like cityBuilder's applyWorldUV)
  {
    const g = new T.PlaneGeometry(3200, 3200).rotateX(-Math.PI / 2).translate(300, 0, 0);
    worldUV(T, g, 1 / 3);
    const ground = new T.Mesh(g, mats.ground('concrete'));
    ground.receiveShadow = true;
    scene.add(ground);
    const pos = [], add = (ax, az, bx, bz, w, y = 0.012) => {
      const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz), nx = -dz / l * w / 2, nz = dx / l * w / 2;
      const v = [[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]];
      for (const i of [0, 1, 2, 0, 2, 3]) pos.push(v[i][0], y, v[i][1]);
    };
    for (const r of data.L.roads) add(r.a.x, r.a.z, r.b.x, r.b.z, r.half * 2);
    const c = data.L.ring.center;
    for (let i = 0; i < c.length; i++) { const a = c[i], b = c[(i + 1) % c.length]; add(a[0], a[2], b[0], b[2], RING.halfWidth * 2, 0.014); }
    add(CITY.half, 0, 1150, 0, 14);
    const rg = new T.BufferGeometry();
    rg.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    rg.computeVertexNormals();
    worldUV(T, rg, 1 / 3);
    const roads = new T.Mesh(rg, mats.ground('asphalt'));
    roads.receiveShadow = true;
    scene.add(roads);
  }

  // buildings: one InstancedMesh per (style, chunk), unit box with its base at y = 0 (same as the game)
  {
    const unitBox = new T.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const size = 400 / split;
    const groups = new Map();
    for (const b of data.L.buildings) {
      if (b.shape === 'cyl') continue;
      const style = BUILDING_STYLES[b.style] ? b.style : 'plain';
      const key = style + '|' + chunkOf(b.x, b.z, size);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const facade = {};
    for (const [key, list] of groups) {
      const [style, ck] = key.split('|');
      facade[style] ||= mats.facade(style, BUILDING_STYLES[style]);
      const im = instanced(unitBox, facade[style], list.length);
      const pal = STYLE_TINTS[style] || [[1, 1, 1]];
      list.forEach((b, i) => {
        im.setMatrixAt(i, m4.compose(p.set(b.x, b.y0, b.z), q.identity(), s.set(b.w, b.h, b.d)));
        im.setColorAt(i, col.setRGB(...pal[Math.floor(b.seed * pal.length) % pal.length]));
      });
      im.castShadow = im.receiveShadow = true;
      im.computeBoundingSphere();
      addChunked(im, ck, size, 4000);
    }
  }

  // cars: one InstancedMesh per (model, part, chunk); parts come from the imported glTF traffic LODs
  const carParts = {};
  const partMat = new Map();
  const makeMat = (part) => {
    const src = part.material;
    if (part.slot === 'paint') return mats.std({ color: 0xffffff, roughness: 0.32, metalness: 0.55, map: src.map ? mats.texture(src.map) : null });
    if (part.slot === 'glass') return mats.std({ color: 0x0b0d10, roughness: 0.06, metalness: 0.2 });
    if (part.slot === 'lightF' || part.slot === 'lightR' || part.slot === 'indicator' || part.slot === 'reverse')
      return mats.basic({ color: part.slot === 'lightF' ? 0xd8d4cc : part.slot === 'lightR' ? 0x6a0d08 : 0x8a4a10 });
    return mats.std({ color: src.color?.getHex?.() ?? 0x777777, roughness: src.roughness ?? 0.7, metalness: src.metalness ?? 0, map: src.map ? mats.texture(src.map) : null, alphaTest: src.transparent || src.alphaTest ? 0.5 : 0 });
  };
  /** One material per source material + slot, shared by every instanced chunk of that car model. */
  const matFor = (part) => {
    const key = part.material.uuid + part.slot;
    if (!partMat.has(key)) partMat.set(key, makeMat(part));
    return partMat.get(key);
  };
  const geoCache = new Map();
  const geo = (g) => { if (!geoCache.has(g.uuid)) geoCache.set(g.uuid, copyGeometry(T, g)); return geoCache.get(g.uuid); };
  {
    const size = 100 / split;
    const groups = new Map();
    for (const c of data.cars) {
      const key = c.kit + '|' + chunkOf(c.x, c.z, size);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [key, list] of groups) {
      const [kitKey, ck] = key.split('|');
      const kit = data.kits.lod[kitKey];
      const parts = Object.entries(kit.parts).map(([name, pt]) => ({ name, geo: pt.geo, mat: matFor(pt), paint: pt.slot === 'paint', cast: pt.slot === 'paint' || pt.slot === 'body', wheels: false }));
      if (kit.wheel) parts.push({ name: 'wheel', geo: kit.wheel.geo, mat: matFor({ slot: 'body', material: kit.wheel.material }), wheels: true, cast: false });
      for (const pt of parts) {
        const n = pt.wheels ? list.length * kit.params.wheels.length : list.length;
        const im = instanced(geo(pt.geo), pt.mat, n);
        im.name = `car:${kitKey}:${pt.name}:${ck}`;
        let i = 0;
        for (const c of list) {
          const base = new T.Matrix4().compose(p.set(c.x, c.y, c.z), q.setFromEuler(e.set(0, c.rot, 0)), s.set(1, 1, 1));
          if (pt.wheels) {
            for (const w of kit.params.wheels) {
              const local = new T.Matrix4().compose(p.set(w.x, kit.params.r, w.z), q.setFromEuler(e.set(0, w.x < 0 ? Math.PI : 0, 0)), s.set(1, 1, 1));
              im.setMatrixAt(i++, m4.multiplyMatrices(base, local));
            }
          } else {
            im.setMatrixAt(i, base);
            if (pt.paint) im.setColorAt(i, col.setRGB(...c.color));
            i++;
          }
        }
        im.castShadow = pt.cast; im.receiveShadow = true;
        im.computeBoundingSphere();
        addChunked(im, ck, size, 150);
      }
    }
    // the "player" car in front of the chase camera: the full-detail model
    const kit = data.kits.full.riverside || data.kits.lod.riverside;
    const player = new T.Group();
    for (const pt of Object.values(kit.parts)) {
      const m = new T.Mesh(geo(pt.geo), makeMat(pt));
      m.castShadow = pt.slot === 'paint' || pt.slot === 'body'; m.receiveShadow = true;
      player.add(m);
    }
    if (kit.wheel) for (const w of kit.params.wheels) {
      const m = new T.Mesh(geo(kit.wheel.geo), makeMat({ slot: 'body', material: kit.wheel.material }));
      m.position.set(w.x, kit.params.r, w.z); if (w.x < 0) m.rotation.y = Math.PI;
      m.castShadow = true;
      player.add(m);
    }
    scene.add(player);
    carParts.player = player;
  }

  const sunDir = new T.Vector3(...SUN_DIR).normalize();
  /** Put the camera, player car, shadow frustum and chunk culling at path pose i. */
  function setPose(pose) {
    camera.position.set(...pose.cam);
    camera.lookAt(...pose.look);
    camera.updateMatrixWorld();
    carParts.player.position.set(...pose.focus);
    carParts.player.rotation.y = pose.heading;
    carParts.player.visible = pose.seg !== 'aerial';
    const texel = (SHADOW_EXT * 2) / SHADOW_MAP;
    const fx = Math.round(pose.focus[0] / texel) * texel, fz = Math.round(pose.focus[2] / texel) * texel;
    sun.target.position.set(fx, 0, fz);
    sun.position.set(fx, 0, fz).addScaledVector(sunDir, 400);
    sun.target.updateMatrixWorld();
    const cp = camera.position;
    for (const c of chunks) {
      const dx = Math.max(0, Math.abs(cp.x - c.cx) - c.half), dz = Math.max(0, Math.abs(cp.z - c.cz) - c.half);
      c.obj.visible = dx * dx + dz * dz < c.maxDist * c.maxDist;
    }
  }
  return { scene, camera, sun, setPose, chunkCount: chunks.length };
}

function worldUV(T, g, k) {
  const pos = g.attributes.position, uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) * k; uv[i * 2 + 1] = pos.getZ(i) * k; }
  g.setAttribute('uv', new T.BufferAttribute(uv, 2));
  return g;
}

/** Re-wrap a geometry from the 'three' module copy in the target namespace (shares the typed arrays). */
function copyGeometry(T, src) {
  const g = new T.BufferGeometry();
  for (const [name, a] of Object.entries(src.attributes)) g.setAttribute(name, new T.BufferAttribute(a.array, a.itemSize, a.normalized));
  if (src.index) g.setIndex(new T.BufferAttribute(src.index.array, 1));
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------------------------
export const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export const round2 = (v) => Math.round(v * 100) / 100;

/** Yield to the event loop without timer throttling (setTimeout is clamped to >= 1 s in a hidden page). */
const mc = new MessageChannel(), waiters = [];
mc.port1.onmessage = () => waiters.shift()?.();
export const tick = () => new Promise((r) => { waiters.push(r); mc.port2.postMessage(0); });
