// Chunked instancing / merging so the renderer can frustum-cull and distance-cull per 400 m cell.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const CHUNK = 400;
const chunkKey = (x, z, size = CHUNK) => `${Math.floor(x / size)},${Math.floor(z / size)}`;
const chunkCenter = (key, size = CHUNK) => { const [a, b] = key.split(',').map(Number); return [(a + 0.5) * size, (b + 0.5) * size]; };

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
export function trs(x, y, z, rotY = 0, sx = 1, sy = 1, sz = 1, rotX = 0) {
  _e.set(rotX, rotY, 0, 'YXZ');
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
}

/** Shared by every distance-faded material: the quality multiplier on cull distances. */
export const FADE = { uCullMul: { value: 1 } };
const fadeCache = new Map();

/**
 * Per-instance dithered distance fade for an instanced material. Instances dissolve (screen-door, no sorting)
 * between 72% and 94% of maxDist by their own distance, so they are gone before CullRegistry hides the whole
 * chunk at maxDist (chunk distance <= instance distance): no chunk-sized pop-in.
 */
export function fadeMaterial(base, maxDist, fadeIn = 0) {
  const key = base.uuid + '|' + maxDist + '|' + fadeIn;
  if (fadeCache.has(key)) return fadeCache.get(key);
  const m = base.clone();
  const uFar = { value: maxDist }, uIn = { value: fadeIn };
  const origCompile = base.onBeforeCompile, origKey = base.customProgramCacheKey?.bind(base);
  m.onBeforeCompile = (sh, r) => {
    if (origCompile) origCompile.call(base, sh, r);
    sh.uniforms.uFadeFar = uFar;
    sh.uniforms.uFadeIn = uIn;
    sh.uniforms.uCullMul = FADE.uCullMul;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFadeDist;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        #ifdef USE_INSTANCING
          vFadeDist = distance((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz, cameraPosition.xz);
        #else
          vFadeDist = 0.0;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFadeDist; uniform float uFadeFar; uniform float uFadeIn; uniform float uCullMul;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        {
          float far = uFadeFar * uCullMul;
          float keep = 1.0 - smoothstep(far * 0.72, far * 0.94, vFadeDist);
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (ign > keep) discard;
          // fade-in: the complement of a nearer LOD's fade-out (same noise, so the two cross-dissolve exactly)
          float near = uFadeIn * uCullMul;
          if (uFadeIn > 0.0 && ign <= 1.0 - smoothstep(near * 0.72, near * 0.94, vFadeDist)) discard;
        }`);
  };
  m.customProgramCacheKey = () => (origKey ? origKey() : '') + '|fade';
  // the base material may be animated at runtime (lamp/billboard emissive at night, colour changes): mirror it
  m.onBeforeRender = () => {
    if (m.emissive && base.emissive) { m.emissive.copy(base.emissive); m.emissiveIntensity = base.emissiveIntensity; }
    if (m.color && base.color) m.color.copy(base.color);
    m.opacity = base.opacity;
    if (m.emissiveMap !== base.emissiveMap) { m.emissiveMap = base.emissiveMap; m.needsUpdate = true; }
  };
  fadeCache.set(key, m);
  return m;
}

/** Registry of everything that is distance-culled. */
export class CullRegistry {
  constructor() { this.items = []; }
  add(object, cx, cz, maxDist, half = CHUNK / 2) { this.items.push({ object, cx, cz, maxDist, half }); }
  update(camPos, mul = 1) {
    FADE.uCullMul.value = mul;
    for (const it of this.items) {
      const dx = Math.max(0, Math.abs(camPos.x - it.cx) - it.half);
      const dz = Math.max(0, Math.abs(camPos.z - it.cz) - it.half);
      it.object.visible = dx * dx + dz * dz < it.maxDist * it.maxDist * mul * mul;
    }
  }
}

export class InstanceBatches {
  constructor(scene, cull, chunk = CHUNK) { this.scene = scene; this.cull = cull; this.kinds = new Map(); this.drawn = 0; this.chunk = chunk; }
  define(name, geometry, material, opts = {}) {
    if (!this.kinds.has(name)) this.kinds.set(name, { geometry, material, opts, chunks: new Map() });
    return name;
  }
  has(name) { return this.kinds.has(name); }
  add(name, matrix, color = null) {
    const k = this.kinds.get(name);
    const key = chunkKey(matrix.elements[12], matrix.elements[14], this.chunk);
    if (!k.chunks.has(key)) k.chunks.set(key, { m: [], c: [] });
    const c = k.chunks.get(key);
    c.m.push(matrix);
    c.c.push(color);
    return { name, key, idx: c.m.length - 1 };
  }
  /** Hide one instance (e.g. a prop that has become a physics object). */
  hide(h) {
    const mesh = this.meshes?.get(h.name + '|' + h.key);
    if (!mesh) return;
    mesh.setMatrixAt(h.idx, new THREE.Matrix4().makeScale(0, 0, 0));
    mesh.instanceMatrix.needsUpdate = true;
  }
  /** Add a multi-material prop: parts = { materialKey: geometry }. */
  addParts(prefix, parts, M, matrix, opts = {}, color = null) {
    const handles = [];
    for (const [mk, geo] of Object.entries(parts)) {
      if (!geo?.isBufferGeometry) continue;
      const mat = M[mk];
      if (!mat) continue;
      const name = `${prefix}:${mk}`;
      this.define(name, geo, mat, opts);
      handles.push(this.add(name, matrix, color));
    }
    return handles;
  }
  build() {
    this.meshes = new Map();
    for (const [name, k] of this.kinds) {
      for (const [key, c] of k.chunks) {
        const fade = k.opts.maxDist && k.opts.maxDist < 2000 && k.opts.fade !== false;
        const mesh = new THREE.InstancedMesh(k.geometry, fade ? fadeMaterial(k.material, k.opts.maxDist, k.opts.fadeIn || 0) : k.material, c.m.length);
        for (let i = 0; i < c.m.length; i++) {
          mesh.setMatrixAt(i, c.m[i]);
          if (c.c[i]) mesh.setColorAt(i, c.c[i]);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = !!k.opts.cast;
        mesh.receiveShadow = k.opts.receive !== false;
        mesh.name = name;
        mesh.matrixAutoUpdate = false;
        this.scene.add(mesh);
        this.meshes.set(name + '|' + key, mesh);
        const [cx, cz] = chunkCenter(key, this.chunk);
        this.cull.add(mesh, cx, cz, k.opts.maxDist || 5000, this.chunk / 2);
        this.drawn++;
      }
    }
  }
}

/** Accumulates flat quads/strips (roads, markings) into one indexed geometry per material and chunk. */
export class StripBins {
  constructor(scene, cull) { this.scene = scene; this.cull = cull; this.bins = new Map(); }
  _bin(mat, x, z) {
    const key = mat.uuid + '|' + chunkKey(x, z);
    if (!this.bins.has(key)) this.bins.set(key, { mat, key: chunkKey(x, z), pos: [], uv: [], idx: [] });
    return this.bins.get(key);
  }
  /** Quad from a to b (centreline) with width w; y per end. uvScale: world metres per texture repeat. */
  quad(mat, ax, ay, az, bx, by, bz, w, uvScale = 3, lift = 0) {
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * w / 2, nz = (dx / l) * w / 2;
    const b = this._bin(mat, (ax + bx) / 2, (az + bz) / 2);
    const base = b.pos.length / 3;
    const v = [[ax + nx, ay + lift, az + nz], [ax - nx, ay + lift, az - nz], [bx + nx, by + lift, bz + nz], [bx - nx, by + lift, bz - nz]];
    for (const p of v) { b.pos.push(...p); b.uv.push(p[0] / uvScale, p[2] / uvScale); }
    b.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  /** Decal quad from a 4x4 atlas cell. rot = heading of the decal's long (l) axis. */
  decal(mat, x, y, z, w, l, rot, cell) {
    const ax = Math.sin(rot), az = Math.cos(rot);   // along
    const cxv = -Math.cos(rot), czv = Math.sin(rot); // across, toward the viewer's right when facing `rot`
    const b = this._bin(mat, x, z);
    const base = b.pos.length / 3;
    const u0 = (cell % 4) / 4, v1 = 1 - Math.floor(cell / 4) / 4, u1 = u0 + 0.25, v0 = v1 - 0.25;
    const e = 0.004; // inset to avoid bleeding from neighbouring cells
    const corners = [[-1, -1, u0 + e, v0 + e], [1, -1, u1 - e, v0 + e], [-1, 1, u0 + e, v1 - e], [1, 1, u1 - e, v1 - e]];
    for (const [sa, sl, u, v] of corners) {
      b.pos.push(x + cxv * sa * w / 2 + ax * sl * l / 2, y, z + czv * sa * w / 2 + az * sl * l / 2);
      b.uv.push(u, v);
    }
    b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  /** Continuous strip along a polyline [[x,y,z],...] with half width; closed loops supported. */
  strip(mat, pts, half, uvScale = 6, lift = 0, closed = false) {
    const n = pts.length;
    const L = [], R = [];
    for (let i = 0; i < n; i++) {
      const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], c = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      let tx = c[0] - a[0], tz = c[2] - a[2];
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      L.push([pts[i][0] + tz * half, pts[i][1] + lift, pts[i][2] - tx * half]);
      R.push([pts[i][0] - tz * half, pts[i][1] + lift, pts[i][2] + tx * half]);
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const b = this._bin(mat, pts[i][0], pts[i][2]);
      const base = b.pos.length / 3;
      for (const p of [L[i], R[i], L[j], R[j]]) { b.pos.push(...p); b.uv.push(p[0] / uvScale, p[2] / uvScale); }
      // L is on the +normal side (left of travel); winding chosen for an upward normal
      b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  build(opts = {}) {
    const out = [];
    for (const b of this.bins.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, b.mat);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      const [cx, cz] = chunkCenter(b.key);
      this.cull.add(mesh, cx, cz, opts.maxDist || 3000);
      out.push(mesh);
    }
    return out;
  }
}

/** Merges arbitrary world-space geometries per material and chunk. */
export class MergeBins {
  constructor(scene, cull) { this.scene = scene; this.cull = cull; this.bins = new Map(); }
  add(mat, geo, opts = {}) {
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    const key = mat.uuid + '|' + chunkKey(c.x, c.z) + '|' + (opts.cast ? 1 : 0);
    if (!this.bins.has(key)) this.bins.set(key, { mat, chunk: chunkKey(c.x, c.z), list: [], opts });
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    g.clearGroups?.();
    this.bins.get(key).list.push(g);
  }
  build() {
    for (const b of this.bins.values()) {
      const g = mergeGeometries(b.list);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, b.mat);
      mesh.receiveShadow = true;
      mesh.castShadow = !!b.opts.cast;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      const [cx, cz] = chunkCenter(b.chunk);
      this.cull.add(mesh, cx, cz, b.opts.maxDist || 3000);
    }
  }
}

/** Planar world-space UVs (top faces use XZ, sides use the dominant horizontal axis + Y). */
export function applyWorldUV(geo, scale = 0.25) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
    let u, v;
    if (ny > 0.5) { u = p.getX(i); v = p.getZ(i); }
    else if (nx > nz) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u * scale; uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}
