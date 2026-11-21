// Chase / far chase / hood / cockpit / cinematic cameras with damping, collision and dynamic FOV.
import * as THREE from 'three';
import { clamp, lerp, damp } from '../core/rng.js';
import { GROUPS } from '../core/physicsGroups.js';

export const CAMERA_MODES = [
  { id: 'chase', label: 'Chase' },
  { id: 'far', label: 'Far Chase' },
  { id: 'hood', label: 'Hood' },
  { id: 'cockpit', label: 'Cockpit' },
  { id: 'cinematic', label: 'Cinematic' },
];

const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _fwd = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

export class CameraRig {
  constructor(camera, { RAPIER, world, excludeBody }) {
    this.camera = camera;
    this.R = RAPIER;
    this.world = world;
    this.exclude = excludeBody;
    this.modeIndex = 0;
    this.yaw = 0;
    this.pos = new THREE.Vector3(0, 3, -8);
    this.fov = 60;
    this.orbit = 0;
    this.lookOffset = 0;
    this.lookPitch = 0;
    this.lastMouse = 0;
    this.shotTimer = 0;
    this.shot = 0;
    this.headLag = new THREE.Vector3();
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    this.smoothQuat = new THREE.Quaternion();
    this.prevVel = new THREE.Vector3();
    this.kickOff = new THREE.Vector3();
    this.kickVel = new THREE.Vector3();
    this.shakeAmp = 0;
  }

  /** Impact response: the camera carries on along the car's motion, then springs back, with a short shake. */
  kick(carVel, strength) {
    const dir = carVel.clone().setY(0);
    if (dir.lengthSq() > 0.01) dir.normalize();
    this.kickVel.addScaledVector(dir, 2.5 + strength * 7);
    this.kickVel.y += strength * 1.2;
    this.shakeAmp = Math.max(this.shakeAmp, 0.02 + strength * 0.06);
  }

  applyKick(dt, cam) {
    // critically damped-ish spring
    const k = 70, c = 11;
    this.kickVel.addScaledVector(this.kickOff, -k * dt).multiplyScalar(Math.max(0, 1 - c * dt));
    this.kickOff.addScaledVector(this.kickVel, dt);
    const scale = this.mode === 'cockpit' || this.mode === 'hood' ? 0.25 : 1;
    cam.position.addScaledVector(this.kickOff, scale);
    if (this.shakeAmp > 0.0005) {
      cam.rotateX((Math.random() - 0.5) * this.shakeAmp);
      cam.rotateZ((Math.random() - 0.5) * this.shakeAmp);
      this.shakeAmp *= Math.exp(-6 * dt);
    }
  }

  get mode() { return CAMERA_MODES[this.modeIndex].id; }
  get label() { return CAMERA_MODES[this.modeIndex].label; }
  next() { this.modeIndex = (this.modeIndex + 1) % (CAMERA_MODES.length - 1); return this.mode; }
  setMode(id) { this.modeIndex = Math.max(0, CAMERA_MODES.findIndex((m) => m.id === id)); }
  toggleCinematic() {
    if (this.mode === 'cinematic') this.modeIndex = this.prevIndex ?? 0;
    else { this.prevIndex = this.modeIndex; this.setMode('cinematic'); }
    return this.mode;
  }
  mouseLook(dx, dy) {
    this.lookOffset = clamp(this.lookOffset - dx * 0.004, -Math.PI, Math.PI);
    this.lookPitch = clamp(this.lookPitch + dy * 0.003, -0.3, 0.6);
    this.lastMouse = performance.now();
  }

  /** car: { pos, quat, vel, speed, rpm, driverEye } */
  update(dt, car) {
    const cam = this.camera;
    const speed = car.vel.length();
    _fwd.set(0, 0, 1).applyQuaternion(car.quat);
    const carYaw = Math.atan2(_fwd.x, _fwd.z);
    const accel = _v.copy(car.vel).sub(this.prevVel).divideScalar(Math.max(dt, 1e-3));
    this.prevVel.copy(car.vel);
    if (performance.now() - this.lastMouse > 1800) {
      this.lookOffset *= 1 - damp(3, dt);
      this.lookPitch *= 1 - damp(3, dt);
    }
    let targetFov = 60;
    const mode = this.mode;

    if (mode === 'chase' || mode === 'far') {
      // follow heading, leaning slightly toward the direction of travel when sliding
      let desired = carYaw;
      if (speed > 4 && car.speed > 0) {
        const velYaw = Math.atan2(car.vel.x, car.vel.z);
        desired = angleLerp(carYaw, velYaw, 0.35);
      }
      if (car.speed < -1) desired = carYaw; // reversing: keep looking forward
      this.yaw = angleLerp(this.yaw, desired + this.lookOffset, damp(mode === 'far' ? 3.5 : 4.5, dt));
      const far = mode === 'far';
      const dist = (far ? 9.5 : 5.9) + clamp(speed / 70, 0, 1) * (far ? 2.5 : 1.4);
      const height = (far ? 3.1 : 1.85) + this.lookPitch * 4;
      _t.set(car.pos.x, car.pos.y + 1.0, car.pos.z);
      const want = _v.set(car.pos.x - Math.sin(this.yaw) * dist, car.pos.y + height, car.pos.z - Math.cos(this.yaw) * dist);
      // collision: pull the camera in front of walls between car and camera
      const dir = want.clone().sub(_t);
      const len = dir.length();
      dir.normalize();
      this.ray.origin.x = _t.x; this.ray.origin.y = _t.y; this.ray.origin.z = _t.z;
      this.ray.dir.x = dir.x; this.ray.dir.y = dir.y; this.ray.dir.z = dir.z;
      const hit = this.world.castRay(this.ray, len, true, undefined, GROUPS.cameraRay, undefined, this.exclude);
      if (hit) want.copy(_t).addScaledVector(dir, Math.max(0.8, hit.timeOfImpact - 0.35));
      // vertical damping only (horizontal is locked to the smoothed yaw)
      this.pos.x = want.x; this.pos.z = want.z;
      this.pos.y = lerp(this.pos.y, want.y, damp(hit ? 30 : 8, dt));
      cam.position.copy(this.pos);
      // subtle speed shake
      // high-speed buffeting: smooth low-frequency wobble (per-frame random jitter reads as stutter)
      const sh = clamp((speed - 35) / 50, 0, 1) * 0.018;
      if (sh > 0) { const tt = performance.now() * 0.001; cam.position.x += Math.sin(tt * 13.1) * Math.sin(tt * 3.7) * sh; cam.position.y += Math.sin(tt * 11.3 + 1.7) * sh * 0.6; }
      const look = _t.set(car.pos.x + Math.sin(this.yaw) * 2.5, car.pos.y + (far ? 1.2 : 1.05), car.pos.z + Math.cos(this.yaw) * 2.5);
      cam.lookAt(look);
      targetFov = 58 + clamp(speed / 75, 0, 1) * 22;
    } else if (mode === 'hood' || mode === 'cockpit') {
      const local = mode === 'hood' ? new THREE.Vector3(0, 1.12, 0.75) : car.driverEye.clone();
      // head inertia: lean against acceleration (in the car's local frame)
      const inv = _q2.copy(car.quat).invert();
      const la = accel.clone().applyQuaternion(inv).multiplyScalar(mode === 'cockpit' ? -0.0035 : -0.0015);
      la.clampLength(0, 0.06);
      this.headLag.lerp(la, damp(6, dt));
      local.add(this.headLag);
      cam.position.copy(local.applyQuaternion(car.quat).add(car.pos));
      // stabilise: follow yaw fully, damp pitch/roll
      _q.copy(car.quat).multiply(FLIP);
      this.smoothQuat.slerp(_q, damp(mode === 'hood' ? 9 : 14, dt));
      cam.quaternion.copy(this.smoothQuat);
      cam.rotateY(this.lookOffset);
      cam.rotateX(-this.lookPitch * 0.5);
      if (mode === 'cockpit') {
        const vib = 0.0004 + clamp(car.rpm / 8000, 0, 1) * 0.0008 + clamp(speed / 80, 0, 1) * 0.001;
        const tt = performance.now() * 0.001;
        cam.rotateX(Math.sin(tt * 41.0 + Math.sin(tt * 7.0)) * vib * 0.5);
        cam.rotateZ(Math.sin(tt * 29.0) * vib * 0.5);
        cam.rotateX(-0.09);
        targetFov = 74;
      } else targetFov = 66 + clamp(speed / 75, 0, 1) * 10;
    } else {
      // cinematic: alternating orbit and low tracking shots
      this.shotTimer -= dt;
      if (this.shotTimer <= 0) { this.shotTimer = 9; this.shot = (this.shot + 1) % 3; }
      this.orbit += dt * 0.22;
      let off;
      if (this.shot === 0) off = new THREE.Vector3(Math.sin(this.orbit) * 7.5, 1.4 + Math.sin(this.orbit * 0.7) * 0.6, Math.cos(this.orbit) * 7.5);
      else if (this.shot === 1) off = new THREE.Vector3(2.6, 0.45, 5.5).applyQuaternion(car.quat);
      else off = new THREE.Vector3(-3.6, 0.9, -6.5).applyQuaternion(car.quat);
      const want = car.pos.clone().add(off);
      this.pos.lerp(want, damp(this.shot === 0 ? 3 : 6, dt));
      cam.position.copy(this.pos);
      cam.lookAt(car.pos.x, car.pos.y + 0.7, car.pos.z);
      targetFov = this.shot === 0 ? 40 : 34;
    }
    this.applyKick(dt, cam);
    this.fov = lerp(this.fov, targetFov, damp(3, dt));
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    this.yaw = mode === 'chase' || mode === 'far' ? this.yaw : carYaw;
  }
}

function angleLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
