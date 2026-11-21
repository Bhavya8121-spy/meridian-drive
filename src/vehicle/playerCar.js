// Player vehicle: binds the physics model to the visual model (interpolated), drives lights,
// steering wheel, wheel animation, headlight beams and skid marks.
import * as THREE from 'three';
import { VehiclePhysics } from './vehiclePhysics.js';
import { disposeCarModel } from './carModel.js';
import { createVehicleModel } from './gltfCars.js';
import { SkidMarks } from './skidmarks.js';
import { SPORTS_CAR } from './specs.js';
import { clamp, lerp, damp } from '../core/rng.js';

const BEAM_VS = /* glsl */`
varying float vAlong; varying vec3 vN; varying vec3 vV;
void main(){
  vAlong = -position.y / 26.0 + 0.5;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const BEAM_FS = /* glsl */`
uniform float uIntensity; varying float vAlong; varying vec3 vN; varying vec3 vV;
void main(){
  float edge = pow(abs(dot(vN, vV)), 1.6);
  float fade = (1.0 - smoothstep(0.0, 1.0, vAlong)) * smoothstep(0.0, 0.06, vAlong);
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * uIntensity * edge * fade * 0.12, 1.0);
}`;

export class PlayerCar {
  constructor({ scene, RAPIER, world, M, preset, surfaceAt, position, heading, spec = SPORTS_CAR, type, skids }) {
    this.phys = new VehiclePhysics(RAPIER, world, spec, { preset, surfaceAt, position, heading });
    const model = createVehicleModel(M, type, spec.wheelWidth, spec.electric);
    this.model = model;
    scene.add(model.root);
    this.headlightsOn = false;
    this.indicator = 0; // -1 left, 1 right, 2 hazard
    this.blink = 0;
    this.prev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.curr = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.snapshot();
    this.snapshot();

    // headlights: two spotlights + additive volumetric beams
    this.beams = [];
    this.spots = model.headlightPos.map((p) => {
      const l = new THREE.SpotLight(0xfff4e6, 0, 95, 0.42, 0.55, 1.4);
      l.position.copy(p);
      l.target.position.set(p.x * 0.6, 0.0, p.z + 20);
      model.root.add(l, l.target);
      const beamMat = new THREE.ShaderMaterial({ vertexShader: BEAM_VS, fragmentShader: BEAM_FS, uniforms: { uIntensity: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(4.6, 26, 24, 1, true), beamMat);
      cone.position.set(p.x, p.y - 0.5, p.z + 13);
      cone.rotation.x = -Math.PI / 2 - 0.03;
      model.root.add(cone);
      this.beams.push(cone);
      return l;
    });
    this.skids = skids ?? new SkidMarks(scene, M.skid);
    this._side = new THREE.Vector3();
  }

  get body() { return this.phys.body; }

  dispose() {
    this.phys.world.removeRigidBody(this.body);
    disposeCarModel(this.model);
    for (const beam of this.beams) beam.material.dispose();
    this.skids.last.fill(null);
  }

  setPaint(hex) { this.model.materials.paint.color.set(hex); }

  snapshot() {
    this.prev.pos.copy(this.curr.pos);
    this.prev.quat.copy(this.curr.quat);
    const t = this.phys.body.translation(), r = this.phys.body.rotation();
    this.curr.pos.set(t.x, t.y, t.z);
    this.curr.quat.set(r.x, r.y, r.z, r.w);
  }

  step(dt, input) {
    this.snapshot();
    this.phys.step(dt, input);
  }

  reset(p, heading) {
    this.phys.reset(p, heading);
    this.snapshot();
    this.snapshot();
  }

  /** Interpolated visual update. alpha: fraction between previous and current physics step. */
  update(dt, alpha, env) {
    this.pos.lerpVectors(this.prev.pos, this.curr.pos, alpha);
    this.quat.slerpQuaternions(this.prev.quat, this.curr.quat, alpha);
    const lv = this.phys.body.linvel();
    this.vel.set(lv.x, lv.y, lv.z);
    const root = this.model.root;
    root.position.copy(this.pos);
    root.quaternion.copy(this.quat);
    const P = this.phys, S = P.spec;
    // wheels
    this.model.wheels.forEach((w, i) => {
      const pw = P.wheels[i];
      const y = S.mountY - pw.len;
      w.hub.position.y = lerp(w.hub.position.y, y, damp(40, dt));
      w.hub.rotation.y = pw.steer;
      w.spin.rotation.x = w.flip ? -pw.spin : pw.spin;
    });
    this.model.steering.rotation.z = P.steerAngle * 6.5;

    // lights
    const m = this.model.materials;
    const braking = P.brake > 0.1 && Math.abs(P.speed) > 0.3 && P.gear !== -1 || (P.gear === -1 && P.throttle === 0 && P.brake > 0.1);
    const night = env.night;
    const lightsOn = this.headlightsOn;
    m.tail.emissiveIntensity = braking ? 3.2 : lightsOn ? 1.1 : 0.5;
    m.reverse.emissiveIntensity = P.gear === -1 ? 2.2 : 0;
    m.headLens.emissiveIntensity = lightsOn ? 6 : 0.05;
    m.drl.emissiveIntensity = 2.5;
    this.blink = (this.blink + dt) % 0.8;
    const blinkOn = this.indicator !== 0 && this.blink < 0.4;
    m.indicator.emissiveIntensity = blinkOn ? 8 : 0;
    this.blinkEdge = blinkOn !== this.lastBlink;
    this.lastBlink = blinkOn;
    const beamI = lightsOn ? 1 : 0;
    for (const l of this.spots) l.intensity = lerp(l.intensity, beamI * 260, damp(12, dt));
    const haze = 0.25 + env.cur.haze * 1.2 + env.cur.rain * 0.8;
    for (const b of this.beams) {
      b.material.uniforms.uIntensity.value = beamI * haze * (0.35 + night * 0.9);
      b.visible = beamI > 0;
    }

    // skid marks from contact patches
    for (let i = 0; i < 4; i++) {
      const pw = P.wheels[i];
      const intensity = pw.contact ? clamp((pw.slide - 2.2) / 6, 0, 0.95) : 0;
      if (intensity > 0 || this.skids.last[i]) {
        this._side.set(1, 0, 0).applyQuaternion(this.quat);
        this.skids.add(i, pw.point, this._side, intensity);
      }
    }
  }
}
