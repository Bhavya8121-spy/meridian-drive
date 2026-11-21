// Pooled spark / debris-chip particles for impacts and scraping (CPU-integrated, one draw call).
import * as THREE from 'three';

const VS = /* glsl */`
attribute float aLife;
attribute float aSize;
varying float vLife;
void main() {
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (1.0 + 3.0 * aLife) * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FS = /* glsl */`
varying float vLife;
void main() {
  if (vLife <= 0.0) discard;
  vec2 c = gl_PointCoord - 0.5;
  float d = 1.0 - smoothstep(0.15, 0.5, length(c));
  vec3 hot = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.9, 0.6), vLife);
  gl_FragColor = vec4(hot * (2.0 + 6.0 * vLife), d * vLife);
}`;

export class Sparks {
  constructor(scene, max = 400) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.cursor = 0;
    this.alive = 0;
  }

  /** Emit n sparks at p, thrown along v (car velocity) and spread around the contact normal n. */
  emit(p, n, v, count = 20, energy = 1) {
    for (let i = 0; i < count; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.pos[k * 3] = p.x; this.pos[k * 3 + 1] = p.y; this.pos[k * 3 + 2] = p.z;
      const s = (2 + Math.random() * 6) * energy;
      this.vel[k * 3] = v.x * 0.5 + n.x * s + (Math.random() - 0.5) * 5;
      this.vel[k * 3 + 1] = Math.random() * 4 * energy + 1;
      this.vel[k * 3 + 2] = v.z * 0.5 + n.z * s + (Math.random() - 0.5) * 5;
      this.life[k] = 0.6 + Math.random() * 0.4;
      this.size[k] = 0.05 + Math.random() * 0.06;
    }
    this.alive = this.max;
  }

  update(dt) {
    if (!this.alive) return;
    let any = 0;
    for (let k = 0; k < this.max; k++) {
      if (this.life[k] <= 0) continue;
      any++;
      this.vel[k * 3 + 1] -= 9.81 * dt;
      this.pos[k * 3] += this.vel[k * 3] * dt;
      this.pos[k * 3 + 1] += this.vel[k * 3 + 1] * dt;
      this.pos[k * 3 + 2] += this.vel[k * 3 + 2] * dt;
      if (this.pos[k * 3 + 1] < 0.02) { this.pos[k * 3 + 1] = 0.02; this.vel[k * 3 + 1] *= -0.3; this.vel[k * 3] *= 0.6; this.vel[k * 3 + 2] *= 0.6; }
      this.life[k] -= dt * 1.6;
    }
    this.alive = any;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aLife.needsUpdate = true;
  }
}
