import * as THREE from 'three';
import { distance } from './city.js';
import { signalState } from '../world/layout.js';
import { PedestrianModels } from './pedestrian-models.js';
import { buildStationModels } from './station-models.js';

const clothes = [0x557597, 0xaa654a, 0x6b8466, 0x88719b, 0xd0a35d, 0x374457, 0x9a424b];
const skin = [0xd2a586, 0xb77959, 0x86593f, 0x624031, 0xe6ba98];
const mix = (a, b, t) => a + (b - a) * t;
const COUNT = 28;

export class StreetLife {
  constructor(scene, city, physics) {
    this.city = city;
    this.scene = scene;
    this.object = new THREE.Object3D();
    const material = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const body = new THREE.CapsuleGeometry(0.16, 0.35, 3, 7);
    const head = new THREE.SphereGeometry(0.118, 8, 6);
    const limb = new THREE.CapsuleGeometry(0.055, 0.28, 2, 6);
    this.body = new THREE.InstancedMesh(body, material, COUNT + 2);
    this.head = new THREE.InstancedMesh(head, material, COUNT + 2);
    this.limbs = new THREE.InstancedMesh(limb, material, (COUNT + 2) * 4);
    for (const mesh of [this.body, this.head, this.limbs]) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(mesh);
    }
    for (let i = 0; i < COUNT + 2; i++) {
      this.body.setColorAt(i, new THREE.Color(clothes[i % clothes.length]));
      this.head.setColorAt(i, new THREE.Color(skin[i % skin.length]));
      for (let j = 0; j < 4; j++) this.limbs.setColorAt(i * 4 + j, new THREE.Color(j < 2 ? 0x28303d : clothes[i % clothes.length]));
    }
    this.walkers = [];
    this.refreshIn = 0;
    this.drawIn = 0;
    this.elapsed = 0;
    this.marker = new THREE.Mesh(new THREE.RingGeometry(2.35, 2.55, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x63ddff, transparent: true, opacity: 0.85, depthWrite: false }));
    this.marker.visible = false;
    scene.add(this.marker);
    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = 512;
    this.labelCanvas.height = 128;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.labelTexture, transparent: true, depthWrite: false, toneMapped: false }));
    this.label.scale.set(7.1, 1.775, 1);
    this.label.visible = false;
    scene.add(this.label);
    this.models = new PedestrianModels(scene);
    this.actors = [];
    buildStationModels(scene, city, physics);
  }

  contact(from, to, heading, maxWidth, halfLength, onHit) {
    const sin = Math.sin(heading), cos = Math.cos(heading);
    if (!from || to.y > 1.35 || distance(from, to) > 6) { this.contacts?.clear(); return; }
    const current = new Set();
    for (const person of this.actors) {
      if (person.id == null || Math.abs(person.x - to.x) > 4 || Math.abs(person.z - to.z) > 4) continue;
      const dx = to.x - from.x, dz = to.z - from.z;
      const length = dx * dx + dz * dz;
      const sample = length ? Math.max(0, Math.min(1, ((person.x - from.x) * dx + (person.z - from.z) * dz) / length)) : 0;
      const x = person.x - from.x - dx * sample, z = person.z - from.z - dz * sample;
      if (Math.abs(x * cos - z * sin) > maxWidth + 0.21 || Math.abs(x * sin + z * cos) > halfLength + 0.23) continue;
      current.add(person.id);
      if (!this.contacts?.has(person.id)) onHit(person);
    }
    this.contacts = current;
  }

  placePerson(i, x, z, heading, gait, y = 0, id = null, walking = gait !== 0) {
    this.actors.push({ x, z, y, heading, id, walking });
    if (this.models.place(this.actors.at(-1), Math.hypot(x - this.viewer.x, z - this.viewer.z) < 65)) {
      for (const mesh of [this.body, this.head]) this.part(mesh, i, x, -100, z, 0, 0);
      for (let j = 0; j < 4; j++) this.part(this.limbs, i * 4 + j, x, -100, z, 0, 0);
      return;
    }
    this.part(this.body, i, x, 1.14 + y, z, heading, 0);
    this.part(this.head, i, x, 1.57 + y, z, heading, 0);
    const sideX = Math.cos(heading), sideZ = -Math.sin(heading);
    for (let j = 0; j < 4; j++) {
      const arm = j >= 2;
      const side = j % 2 === 0 ? 1 : -1;
      const offset = side * (arm ? 0.202 : 0.085);
      this.part(this.limbs, i * 4 + j, x + sideX * offset, y + (arm ? 1.06 : 0.60), z + sideZ * offset, heading, gait * side * (arm ? -0.7 : 1));
    }
  }

  part(mesh, i, x, y, z, yaw, pitch) {
    this.object.position.set(x, y, z);
    this.object.rotation.set(pitch, yaw, 0, 'YXZ');
    this.object.updateMatrix();
    mesh.setMatrixAt(i, this.object.matrix);
  }

  update(dt, pos, career, rest, signalTime) {
    const target = career.target;
    this.marker.visible = Boolean(target);
    this.label.visible = Boolean(target && distance(target, pos) < 55 && !rest);
    if (target) {
      if (target !== this.labeled) {
        this.labeled = target;
        const ctx = this.labelCanvas.getContext('2d');
        ctx.clearRect(0, 0, 512, 128);
        ctx.fillStyle = '#10212a';
        ctx.fillRect(0, 0, 512, 128);
        ctx.fillStyle = '#75dbff';
        ctx.fillRect(0, 0, 512, 7);
        ctx.font = 'bold 35px sans-serif';
        ctx.fillText(target.name.split(' · ')[0], 22, 55, 468);
        ctx.font = '29px sans-serif';
        ctx.fillStyle = '#eaf7ff';
        ctx.fillText(target.address, 22, 98, 468);
        this.label.position.set(target.walk.x, 2.8, target.walk.z);
        this.labelTexture.needsUpdate = true;
      }
      this.marker.position.set(target.x, 0.035, target.z);
      this.marker.material.color.setHex(target.type === 'fuel' ? 0x65ebad : target.type === 'charge' ? 0x8eccff : 0x63ddff);
    }
    this.elapsed += dt;
    this.refreshIn -= dt;
    this.drawIn -= dt;
    const h = career.time;
    const shift = h < 5 || h >= 19 ? 'night' : h < 11 ? 'morning' : 'day';
    if (this.refreshIn <= 0 || shift !== this.shift) {
      this.shift = shift;
      const active = shift === 'night' ? ['nightlife', 'home'] : shift === 'morning' ? ['coffee', 'work'] : ['work', 'leisure', 'coffee'];
      this.walkers = this.city.stops.filter((s) => active.includes(s.type) && distance(s, pos) < 230)
        .sort((a, b) => distance(a, pos) - distance(b, pos)).slice(0, shift === 'night' ? 18 : COUNT);
      this.crossings = this.city.crosswalks.filter((walk) => distance(walk, pos) < 130)
        .sort((a, b) => distance(a, pos) - distance(b, pos)).slice(0, shift === 'night' ? 2 : 4);
      this.refreshIn = 1;
    }
    if (this.drawIn > 0) return;
    this.drawIn = 0.05;
    this.viewer = pos;
    this.actors.length = 0;
    this.models.begin(0.05);
    let i = 0;
    for (const walk of this.crossings) {
      const junction = walk.intersection;
      const halfCycle = junction.cycle / 2;
      const phase = (signalTime + junction.offset) % junction.cycle;
      const crossTime = (walk.axis === 'x' ? phase + halfCycle : phase) % junction.cycle;
      const walking = signalState(junction, walk.axis, signalTime) === 'red' && crossTime >= 1 && crossTime <= junction.green - 0.5;
      const progress = walking ? (crossTime - 1) / (junction.green - 1.5) : 0;
      const offset = (progress - 0.5) * (walk.width + 1.6);
      const axisX = walk.axis === 'x';
      this.placePerson(i++, walk.x + (axisX ? 0 : offset), walk.z + (axisX ? offset : 0), axisX ? 0 : Math.PI / 2,
        walking ? Math.sin(this.elapsed * 9) * 0.56 : 0, walking ? 0 : 0.15, `cross-${walk.x}-${walk.z}`, walking);
    }
    for (const stop of this.walkers.slice(0, COUNT - i)) {
      const phase = ((this.elapsed * (1.1 + (stop.id % 5) * 0.08) + stop.id * 7) % 92) - 46;
      const along = 24 - Math.abs(phase);
      const axisX = stop.road.axis === 'x';
      const heading = (axisX ? Math.PI / 2 : 0) + (phase > 0 ? Math.PI : 0);
      const gait = Math.sin(this.elapsed * 8 + stop.id) * 0.56;
      this.placePerson(i++, stop.walk.x + (axisX ? along : 0), stop.walk.z + (axisX ? 0 : along), heading, gait, 0.15, stop.id, true);
    }
    if (career.ride?.phase === 'pickup') {
      const { walk, side, road } = this.city.stops[career.ride.pickup];
      this.placePerson(i++, walk.x, walk.z, road.axis === 'x' ? (side > 0 ? Math.PI : 0) : -side * Math.PI / 2, 0, 0.15, `rider-${career.ride.pickup}`);
    }
    if (rest && rest.elapsed < 1.8) {
      const t = Math.min(1, rest.elapsed / 1.8);
      this.placePerson(i++, mix(rest.from.x, rest.to.x, t), mix(rest.from.z, rest.to.z, t),
        Math.atan2(rest.to.x - rest.from.x, rest.to.z - rest.from.z), Math.sin(this.elapsed * 9) * 0.6, 0.12);
    }
    this.models.finish();
    this.body.count = this.head.count = i;
    this.limbs.count = i * 4;
    for (const mesh of [this.body, this.head, this.limbs]) mesh.instanceMatrix.needsUpdate = true;
  }
}
