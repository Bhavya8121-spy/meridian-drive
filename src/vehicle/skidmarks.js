// Tyre skid marks as a ring buffer of quads with per-vertex alpha.
import * as THREE from 'three';

export class SkidMarks {
  constructor(scene, material, maxQuads = 3000) {
    this.max = maxQuads;
    const pos = new Float32Array(maxQuads * 4 * 3);
    const col = new Float32Array(maxQuads * 4 * 4);
    const uv = new Float32Array(maxQuads * 4 * 2);
    const idx = new Uint32Array(maxQuads * 6);
    for (let i = 0; i < maxQuads; i++) {
      idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(maxQuads * 12).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    material.vertexColors = true;
    material.side = THREE.DoubleSide;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.cursor = 0;
    this.last = [null, null, null, null];
  }

  /** wheelIndex, contact point (Vector3), side vector (Vector3, unit), intensity 0..1 */
  add(i, p, side, intensity, width = 0.25) {
    const last = this.last[i];
    if (intensity <= 0.02) { this.last[i] = null; return; }
    if (!last) { this.last[i] = { p: p.clone(), side: side.clone(), a: intensity }; return; }
    if (last.p.distanceToSquared(p) < 0.09) return;
    if (last.p.distanceToSquared(p) > 9) { this.last[i] = null; return; }
    const g = this.mesh.geometry;
    const pos = g.attributes.position.array, col = g.attributes.color.array;
    const q = this.cursor;
    const h = width / 2;
    const v = [
      last.p.x + last.side.x * h, last.p.y + 0.025, last.p.z + last.side.z * h,
      last.p.x - last.side.x * h, last.p.y + 0.025, last.p.z - last.side.z * h,
      p.x + side.x * h, p.y + 0.025, p.z + side.z * h,
      p.x - side.x * h, p.y + 0.025, p.z - side.z * h,
    ];
    pos.set(v, q * 12);
    const a0 = Math.min(1, last.a), a1 = Math.min(1, intensity);
    col.set([1, 1, 1, a0, 1, 1, 1, a0, 1, 1, 1, a1, 1, 1, 1, a1], q * 16);
    this.cursor = (q + 1) % this.max;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.last[i] = { p: p.clone(), side: side.clone(), a: intensity };
  }
}
