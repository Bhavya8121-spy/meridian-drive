// Raycast-suspension vehicle on a Rapier rigid body.
// Suspension, tyre forces (simplified Pacejka + friction circle), drivetrain and assists are all
// computed here and applied as impulses; Rapier handles integration and chassis collisions.
// Local frame: +Z forward, +Y up, +X left.
import * as THREE from 'three';
import { clamp, lerp, damp } from '../core/rng.js';
import { SURFACE_PROPS } from '../world/layout.js';
import { GROUPS } from '../core/physicsGroups.js';

const CRUMPLE_DEPTH = 0.75;   // metres of 'crush' before rigid contact with fixed obstacles
const SAFE_CONTACT = 2.8;     // closing speed (m/s) allowed to reach the rigid contact
const MAX_CRUSH_G = 90;

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _angv = new THREE.Vector3();
const _com = new THREE.Vector3();
const _mount = new THREE.Vector3();
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _wl = new THREE.Vector3();
const _n = new THREE.Vector3();
const _F = new THREE.Vector3();
const _tmp = new THREE.Vector3();

function torqueAt(curve, rpm) {
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, t0] = curve[i - 1], [r1, t1] = curve[i];
      return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return curve[curve.length - 1][1];
}

export class VehiclePhysics {
  constructor(RAPIER, world, spec, opts = {}) {
    this.R = RAPIER;
    this.world = world;
    this.spec = spec;
    this.preset = opts.preset;
    this.surfaceAt = opts.surfaceAt || (() => 1);
    this.weatherGrip = 1;
    this.damage = 0;

    const p = opts.position || { x: 0, y: 1, z: 0 };
    const h = opts.heading || 0;
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setCanSleep(false)
      .setCcdEnabled(true)
      .setAngularDamping(0.25)
      .setLinearDamping(0.01)
      .setAdditionalMassProperties(spec.mass, spec.com, spec.inertia, { x: 0, y: 0, z: 0, w: 1 });
    this.body = world.createRigidBody(desc);
    // Rounded, low-friction, non-bouncy chassis: slides along walls instead of snagging, never rebounds.
    const mk = (hx, hy, hz, x, y, z, r) => {
      const c = world.createCollider(
        RAPIER.ColliderDesc.roundCuboid(hx - r, hy - r, hz - r, r).setTranslation(x, y, z).setDensity(0)
          .setFriction(0.12).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
          .setRestitution(0).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
          .setCollisionGroups(GROUPS.player),
        this.body,
      );
      c.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
      c.setContactForceEventThreshold(2500);
      return c;
    };
    const shape = spec.chassis;
    const halfWidth = shape ? shape.width / 2 - 0.055 : 0.92;
    const halfLength = shape ? shape.length / 2 - 0.07 : 2.2;
    const cabinHalfHeight = shape ? Math.max(0.2, (shape.roof - 0.85) / 2) : 0.22;
    this.colliders = [mk(halfWidth, 0.25, halfLength, 0, 0.6, 0, 0.1), mk(shape ? halfWidth * 0.76 : 0.7, cabinHalfHeight, 1.0, 0, shape ? 0.85 + cabinHalfHeight : 1.05, -0.25, 0.08)];
    this.castBox = new RAPIER.Cuboid(halfWidth, 0.25, halfLength);
    this.crumple = 0;        // accumulated crush (m/s of delta-v) since last read, for damage/feedback
    this.impact = null;      // last crumple impact { dv, point, normal }
    this.colliderHandles = new Set(this.colliders.map((c) => c.handle));

    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.wheels = spec.wheels.map((w) => ({
      ...w,
      comp: 0, prevComp: 0, contact: false, load: 0, len: spec.restLength,
      steer: 0, omega: 0, spin: 0, slide: 0, spinSlip: 0, lock: false,
      point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), surface: 1,
    }));
    this.gear = 1;
    this.rpm = spec.engine.idle;
    this.shiftTimer = 0;
    this.reverseTimer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.steerAngle = 0;
    this.speed = 0;
    this.tcsCut = 0;
    this.tcsActive = false;
    this.absActive = false;
    this.handbrake = false;
    this.onShift = null; // callback(gear)
    this.wheelbase = spec.wheels[0].z - spec.wheels[2].z;
    this.track = spec.wheels[0].x - spec.wheels[1].x;
  }

  setPreset(preset) { this.preset = preset; }

  reset(pos, heading) {
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1;
    this.rpm = this.spec.engine.idle;
    for (const w of this.wheels) { w.comp = w.prevComp = 0; w.omega = 0; }
  }

  /** input: {throttle 0..1, brake 0..1, steer -1..1 (+ = right), handbrake bool} */
  step(dt, input) {
    const S = this.spec, ps = this.preset, b = this.body;
    const t = b.translation(), r = b.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _pos.set(t.x, t.y, t.z);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _left.set(1, 0, 0).applyQuaternion(_q);
    const lv = b.linvel(), av = b.angvel(), wc = b.worldCom();
    _vel.set(lv.x, lv.y, lv.z);
    _angv.set(av.x, av.y, av.z);
    _com.set(wc.x, wc.y, wc.z);
    const vFwd = _vel.dot(_fwd);
    const vLeft = _vel.dot(_left);
    this.speed = vFwd;
    this.speedAbs = _vel.length();
    const mw = S.mass / 4;

    // ---------- gear selection & pedal mapping ----------
    let throttle = clamp(input.throttle, 0, 1);
    let brake = clamp(input.brake, 0, 1);
    if (this.gear >= 1) {
      if (input.brake > 0.1 && vFwd < 0.8 && input.throttle < 0.1) {
        this.reverseTimer += dt;
        if (this.reverseTimer > 0.25) { this.gear = -1; this.reverseTimer = 0; this.onShift?.(-1); }
      } else this.reverseTimer = 0;
    } else if (this.gear === -1) {
      throttle = clamp(input.brake, 0, 1);
      brake = clamp(input.throttle, 0, 1);
      if (input.throttle > 0.1 && vFwd > -0.8) { this.gear = 1; this.onShift?.(1); }
    }
    if (input.noFuel) throttle = 0;
    this.handbrake = !!input.handbrake;
    if (throttle < 0.05 && brake < 0.05 && this.speedAbs < 0.4 && !this.handbrake) brake = 0.25; // auto-hold

    // ---------- steering ----------
    const spd = Math.abs(vFwd);
    const steeringLimit = THREE.MathUtils.degToRad(lerp(ps.maxSteerLow, ps.maxSteerHigh, clamp(spd / ps.steerSpeedRef, 0, 1)));
    const corneringLimit = Math.atan((ps.lateralAcceleration ?? Infinity) * this.weatherGrip * this.wheelbase / Math.max(1, spd * spd));
    const maxSteer = this.handbrake ? steeringLimit : Math.min(steeringLimit, corneringLimit);
    let steer = -clamp(input.steer, -1, 1) * maxSteer; // + = left
    if (ps.countersteer > 0 && vFwd > 3 && !this.handbrake) {
      const beta = Math.atan2(vLeft, Math.abs(vFwd));
      steer += clamp(beta * ps.countersteer * clamp((spd - 3) / 8, 0, 1), -0.35, 0.35);
    }
    steer = clamp(steer, -0.7, 0.7);
    this.steerAngle = steer;
    for (const w of this.wheels) {
      if (!w.front) { w.steer = 0; continue; }
      const inner = (steer > 0 && w.x > 0) || (steer < 0 && w.x < 0);
      w.steer = steer * (inner ? 1.1 : 0.92);
    }

    // ---------- drivetrain ----------
    const E = S.engine;
    const ratio = this.gear > 0 ? S.gears[this.gear - 1] : this.gear < 0 ? -S.reverseGear : 0;
    const rearV = (this.wheels[2].omega + this.wheels[3].omega) * 0.5 * S.wheelRadius;
    const groundV = this.wheels[2].contact || this.wheels[3].contact ? rearV : vFwd;
    const wheelRpm = (groundV / S.wheelRadius) * 60 / (2 * Math.PI);
    let rpmTarget = Math.abs(wheelRpm * ratio * S.finalDrive);
    const launching = !S.electric && Math.abs(this.gear) === 1 && rpmTarget < E.idle + throttle * 2600;
    if (launching) rpmTarget = Math.max(rpmTarget, E.idle + throttle * 2600);
    rpmTarget = Math.max(rpmTarget, E.idle);
    if (this.shiftTimer > 0) rpmTarget = lerp(rpmTarget, this.rpm, 0.5);
    this.rpm += (rpmTarget - this.rpm) * damp(14, dt);
    this.rpm = clamp(this.rpm, E.idle * 0.8, E.limiter + 200);

    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.shiftLock = Math.max(0, (this.shiftLock || 0) - dt);
    if (this.gear > 0 && this.shiftTimer <= 0) {
      const up = 3300 + throttle * 4100;
      const down = this.shiftLock > 0 ? 0 : 1500 + throttle * 1500;
      const wheelBased = Math.abs(wheelRpm * S.finalDrive);
      if (wheelBased * S.gears[this.gear - 1] > Math.min(up, E.redline - 150) && this.gear < S.gears.length && !launching) {
        this.gear++; this.shiftTimer = S.shiftTime; this.shiftLock = 1.2; this.onShift?.(this.gear);
      } else if (this.gear > 1 && wheelBased * S.gears[this.gear - 1] < down) {
        const nextRpm = wheelBased * S.gears[this.gear - 2];
        if (nextRpm < E.redline - 600) { this.gear--; this.shiftTimer = S.shiftTime * 0.7; this.onShift?.(this.gear); }
      }
    }

    const powerHealth = 1 - 0.45 * clamp((this.damage - 0.4) / 0.6, 0, 1);
    let engineTorque = 0;
    const limiter = S.maxSpeed ? clamp((S.maxSpeed - spd) / 1.2, 0, 1) : 1;
    const effThrottle = throttle * (1 - this.tcsCut) * limiter;
    if (this.shiftTimer > 0) engineTorque = 0;
    else if (this.rpm >= E.limiter) engineTorque = 0;
    else if (effThrottle > 0.02) engineTorque = torqueAt(E.torque, this.rpm) * effThrottle * ps.powerMul * powerHealth;
    else if (ratio !== 0 && spd > 1) engineTorque = -E.engineBrake * (this.rpm / E.redline);
    // reverse speed limiter
    if (this.gear < 0 && vFwd < -9) engineTorque = 0;
    const driveForce = (engineTorque * ratio * S.finalDrive * S.drivetrainEff) / S.wheelRadius;
    this.throttle = throttle;
    this.brake = brake;
    this.engineLoad = clamp(engineTorque / 620, -0.3, 1);

    // ---------- suspension pass ----------
    const ray = this.ray;
    const maxLen = S.restLength + S.wheelRadius;
    for (const w of this.wheels) {
      _mount.set(w.x, S.mountY, w.z).applyQuaternion(_q).add(_pos);
      ray.origin.x = _mount.x; ray.origin.y = _mount.y; ray.origin.z = _mount.z;
      ray.dir.x = -_up.x; ray.dir.y = -_up.y; ray.dir.z = -_up.z;
      const hit = this.world.castRayAndGetNormal(ray, maxLen, true, undefined, GROUPS.wheelRay, undefined, b);
      w.prevComp = w.comp;
      if (hit) {
        const toi = hit.timeOfImpact;
        w.point.copy(_mount).addScaledVector(_up, -toi);
        w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        w.surface = this.surfaceAt(w.point.x, w.point.z);
        const sp = SURFACE_PROPS[w.surface] || SURFACE_PROPS[1];
        let len = toi - S.wheelRadius;
        if (sp.bump > 0 && spd > 1) len -= sp.bump * (Math.sin(w.point.x * 2.3 + w.point.z * 1.7) + Math.sin(w.point.x * 5.1 - w.point.z * 3.9) * 0.5);
        w.len = clamp(len, 0, S.restLength);
        w.comp = S.restLength - len;
        w.contact = true;
      } else {
        w.len = lerp(w.len, S.restLength, 0.2);
        w.comp = 0;
        w.contact = false;
        w.load = 0;
      }
    }
    const fl = this.wheels[0], fr = this.wheels[1], rl = this.wheels[2], rr = this.wheels[3];
    const arbF = (fl.comp - fr.comp) * S.antiRollFront;
    const arbR = (rl.comp - rr.comp) * S.antiRollRear;
    let grounded = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.contact) continue;
      grounded++;
      const k = w.front ? S.springFront : S.springRear;
      const cvel = (w.comp - w.prevComp) / dt;
      let f = k * w.comp + (cvel > 0 ? S.bumpDamp : S.reboundDamp) * cvel;
      if (w.comp > S.restLength) f += (w.comp - S.restLength) * k * 8; // bump stop
      f += (i === 0 ? arbF : i === 1 ? -arbF : i === 2 ? arbR : -arbR);
      f = clamp(f, 0, S.mass * 9.81 * 3);
      w.load = f;
      _mount.set(w.x, S.mountY, w.z).applyQuaternion(_q).add(_pos);
      _F.copy(_up).multiplyScalar(f * dt);
      b.applyImpulseAtPoint(_F, _mount, true);
    }
    this.grounded = grounded;

    // ---------- tyre pass ----------
    let wheelspinRear = 0;
    this.absActive = false;
    const weather = this.weatherGrip;
    for (const w of this.wheels) {
      if (!w.contact) {
        // free wheel: spin decays, driven wheels can rev
        if (!w.front) w.omega += (driveForce / 2 / 20) * dt;
        w.omega *= 0.995;
        w.spin += w.omega * dt;
        w.slide = 0; w.spinSlip = 0;
        continue;
      }
      const sp = SURFACE_PROPS[w.surface] || SURFACE_PROPS[1];
      _n.copy(w.normal);
      const c = Math.cos(w.steer), s = Math.sin(w.steer);
      _wf.copy(_fwd).multiplyScalar(c).addScaledVector(_left, s);
      _wf.addScaledVector(_n, -_wf.dot(_n)).normalize();
      _wl.crossVectors(_n, _wf).normalize();
      _p.copy(w.point).addScaledVector(_up, S.rollCenter);
      _r.subVectors(_p, _com);
      _pv.crossVectors(_angv, _r).add(_vel);
      const vLong = _pv.dot(_wf);
      const vLat = _pv.dot(_wl);
      const Fz = w.load;
      let mu = sp.mu * ps.grip * weather * (w.front ? 1 : ps.rearGrip);
      const maxF = mu * Fz;

      // longitudinal
      let Fx = 0;
      const driven = !w.front;
      if (driven) Fx += driveForce / 2;
      let brakeF = brake * S.brakeForce * (w.front ? S.brakeBias : 1 - S.brakeBias) / 2;
      let latMul = 1;
      const assisted = (ps.driftAssist || 0) > 0;
      if (this.handbrake && !w.front) {
        brakeF += (S.handbrakeForce / 2) * (assisted ? 0.35 : 1);
        if (spd > 2) latMul = assisted ? Math.max(ps.handbrakeGrip, 0.6) : ps.handbrakeGrip;
      } else if (this.drifting && !w.front && assisted && !this.recovering) {
        latMul = 0.72; // keep the rear loose enough to hold the slide after the handbrake is released
      }
      w.lock = false;
      if (brakeF > 0) {
        if (ps.abs) {
          if (brakeF > maxF * 0.95 && spd > 3) { brakeF = maxF * 0.95; this.absActive = true; }
        } else if (brakeF > maxF && spd > 2) {
          w.lock = true;
        }
        if (this.handbrake && !w.front && spd > 2 && !assisted) w.lock = true;
        const kill = Math.abs(vLong) * mw / dt;
        Fx -= Math.sign(vLong) * Math.min(w.lock ? maxF * 0.85 : brakeF, kill);
      }
      Fx -= Math.sign(vLong) * Math.min(sp.roll * Fz, Math.abs(vLong) * mw / dt);

      // lateral (simplified Pacejka with low-speed velocity constraint)
      const alpha = Math.atan2(vLat, Math.abs(vLong) + 0.6);
      const { B, C } = S.tire;
      let Fy = -Math.sign(alpha) * maxF * Math.sin(C * Math.atan(B * Math.abs(alpha)));
      const kill = -vLat * mw / dt;
      const saturated = Math.abs(Fy) < Math.abs(kill);
      if (!saturated) Fy = kill;
      Fy *= latMul;
      if (w.lock) Fy *= 0.3;

      // friction circle
      let spinSlip = 0;
      if (Math.abs(Fx) > maxF) {
        if (driven && Math.abs(driveForce / 2) > maxF) spinSlip = Math.min(4, (Math.abs(driveForce / 2) - maxF) / Math.max(maxF, 800));
        Fx = Math.sign(Fx) * maxF;
      }
      const latAvail = Math.max(Math.sqrt(Math.max(0, maxF * maxF - Fx * Fx)), maxF * ps.driftSustain);
      if (Math.abs(Fy) > latAvail) Fy = Math.sign(Fy) * latAvail;
      if (driven) wheelspinRear = Math.max(wheelspinRear, spinSlip);

      // longitudinal force at the contact patch (pitch transfer), lateral at the roll centre
      _F.copy(_wf).multiplyScalar(Fx * dt);
      b.applyImpulseAtPoint(_F, w.point, true);
      _F.copy(_wl).multiplyScalar(Fy * dt);
      b.applyImpulseAtPoint(_F, _p, true);

      // wheel state for visuals/audio/skids
      const slideLat = saturated || latMul < 1 ? Math.max(0, Math.abs(vLat) - 0.8) : 0;
      w.slide = slideLat + (w.lock ? Math.abs(vLong) : 0) + spinSlip * 6;
      w.spinSlip = spinSlip;
      let omega = vLong / S.wheelRadius;
      if (w.lock) omega = 0;
      else if (spinSlip > 0) omega += Math.sign(driveForce || 1) * Math.min(spinSlip, 3) * 25;
      w.omega = lerp(w.omega, omega, damp(30, dt));
      w.spin += w.omega * dt;
    }

    // ---------- traction control ----------
    if (ps.tcs > 0 && wheelspinRear > 0.05) {
      this.tcsCut = Math.min(0.9, this.tcsCut + dt * 6 * ps.tcs);
      this.tcsActive = true;
    } else {
      this.tcsCut = Math.max(0, this.tcsCut - dt * 3);
      this.tcsActive = this.tcsCut > 0.05;
    }

    // ---------- aerodynamics ----------
    const v2 = _vel.lengthSq();
    if (v2 > 0.01) {
      const vmag = Math.sqrt(v2);
      _F.copy(_vel).multiplyScalar(-0.5 * 1.225 * S.cdA * vmag * dt);
      b.applyImpulse(_F, true);
      if (grounded > 0) {
        _F.copy(_up).multiplyScalar(-S.downforce * ps.extraDownforce * vFwd * vFwd * dt);
        b.applyImpulse(_F, true);
      }
    }

    // ---------- stability (yaw) control ----------
    if (ps.stability > 0 && grounded >= 3 && spd > 4 && !this.drifting) {
      const yaw = _angv.dot(_up);
      const desired = (vFwd * Math.tan(steer)) / this.wheelbase;
      const excess = yaw - desired;
      const allowance = 0.22 + ps.driftSustain * 0.8 + (this.handbrake ? 0.6 : 0);
      const over = Math.abs(excess) - allowance;
      if (over > 0) {
        const tq = -Math.sign(excess) * over * 9000 * ps.stability;
        _F.copy(_up).multiplyScalar(tq * dt);
        b.applyTorqueImpulse(_F, true);
      }
    }
    // gentle self-righting in the air for arcade play
    if (grounded === 0 && ps.stability > 0.5) {
      _tmp.crossVectors(_up, new THREE.Vector3(0, 1, 0)).multiplyScalar(1200 * dt);
      b.applyTorqueImpulse(_tmp, true);
    }
    this.driftStep(dt, input, throttle, grounded, spd);
    this.crumpleStep(dt);
  }

  /**
   * Drift assist. Measures the slip angle beta (angle between heading and velocity, + = sliding toward the
   * car's left, i.e. nose pointing right of travel) and applies a yaw torque so beta follows a target:
   *   - not drifting: target 0, only beyond ps.gripSlip -> the car stays planted, no snap oversteer;
   *   - drifting (started by the handbrake, or by power-oversteer): target = steering x ps.driftAngle,
   *     so the steering wheel sets the drift angle and centring it straightens the car;
   *   - never beyond ~60 degrees, so the car cannot spin out.
   * A forward push along the velocity offsets tyre scrub so a held drift keeps its speed.
   */
  driftStep(dt, input, throttle, grounded, spd) {
    const ps = this.preset, b = this.body;
    const assist = ps.driftAssist || 0;
    if (!assist || grounded < 3) { this.drifting = false; this.beta = 0; return; }
    const lv = b.linvel(), av = b.angvel();
    const vf = lv.x * _fwd.x + lv.z * _fwd.z, vl = lv.x * _left.x + lv.z * _left.z;
    const speed = Math.hypot(lv.x, lv.z);
    const beta = speed > 1 ? Math.atan2(vl, Math.max(Math.abs(vf), 0.5)) : 0;
    this.beta = beta;
    // rate of change of the travel direction, to work with the yaw rate *relative* to the velocity
    const velHeading = Math.atan2(lv.x, lv.z);
    let dVel = this.prevVelHeading === undefined ? 0 : velHeading - this.prevVelHeading;
    if (dVel > Math.PI) dVel -= 2 * Math.PI; else if (dVel < -Math.PI) dVel += 2 * Math.PI;
    this.prevVelHeading = velHeading;
    const yaw = av.x * _up.x + av.y * _up.y + av.z * _up.z;
    const relYaw = yaw - (speed > 1 ? dVel / dt : 0);

    const steerIn = clamp(input.steer || 0, -1, 1);
    if (!this.drifting) {
      if ((this.handbrake && spd > 7) || (Math.abs(beta) > 0.2 && throttle > 0.5 && spd > 8)) {
        this.drifting = true;
        this.driftEntrySpeed = speed;
        this.driftTime = 0;
      }
    } else if (spd < 4 || (!this.handbrake && Math.abs(beta) < 0.06 && Math.abs(steerIn) < 0.15)) {
      this.drifting = false;
    }
    if (vf < 0 || speed < 3) return; // reversing / parking: nothing to manage

    let target = 0, limit = ps.gripSlip ?? 0.1;
    // steering centred (and no handbrake) while sliding = the driver wants to straighten up
    this.recovering = this.drifting && !this.handbrake && Math.abs(steerIn) < 0.15;
    if (this.drifting) {
      target = steerIn * ps.driftAngle;
      // a handbrake flick kicks the tail out in the steered direction
      if (this.handbrake && Math.abs(target) < 0.38) target = (Math.sign(steerIn || beta) || 1) * 0.38;
      this.driftTime = (this.driftTime || 0) + dt;
      limit = 0;
    }
    target = clamp(target, -1.0, 1.0);
    let err = target - beta;
    if (!this.drifting) err = Math.abs(beta) > limit ? -(beta - Math.sign(beta) * limit) : 0;
    // hard cap: beyond ~60 degrees always pull back hard
    const capped = Math.abs(beta) > 1.05;
    const Kp = capped ? 9 : this.recovering ? 5 : this.drifting ? 2.4 : 7;
    const desiredRel = -Kp * err;                 // positive beta grows when the car yaws right (negative)
    const Iy = this.spec.inertia.y;
    let tq = Iy * (desiredRel - relYaw) * (capped ? 10 : this.drifting ? 6.5 : 8) * assist;
    if (!this.drifting && err === 0) tq = 0;
    tq = clamp(tq, -Iy * 9, Iy * 9);
    b.applyTorqueImpulse({ x: _up.x * tq * dt, y: _up.y * tq * dt, z: _up.z * tq * dt }, true);

    // Hold speed through a drift: aim for the entry speed, easing down to ~70% over 3 s (tyres still scrub),
    // only while on the throttle. This is what makes a held drift feel controllable instead of a stall.
    if (this.drifting && !this.recovering && throttle > 0.2 && this.driftEntrySpeed) {
      const keep = this.driftEntrySpeed * lerp(0.9, 0.7, clamp(this.driftTime / 3, 0, 1));
      const a = clamp((keep - speed) * 3, 0, ps.driftPush * 2) * throttle * assist;
      const J = this.spec.mass * a * dt / speed;
      b.applyImpulse({ x: lv.x * J, y: 0, z: lv.z * J }, true);
    }
  }

  /**
   * Crumple-zone model. Rigid contacts would stop the car from speed within one 8 ms step (hundreds of g).
   * Instead, cast the chassis box ahead along its velocity; when a fixed obstacle is within CRUMPLE_DEPTH
   * and the closing speed exceeds SAFE_CONTACT, decelerate along the contact normal so the car reaches the
   * obstacle at SAFE_CONTACT, like bodywork crushing. Glancing hits only lose their normal component.
   */
  crumpleStep(dt) {
    const b = this.body;
    const lv = b.linvel();
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    if (speed < SAFE_CONTACT) return;
    const t = b.translation(), r = b.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _p.set(0, 0.6, 0).applyQuaternion(_q).add(_tmp.set(t.x, t.y, t.z));
    const dir = { x: lv.x / speed, y: lv.y / speed, z: lv.z / speed };
    const reach = CRUMPLE_DEPTH + speed * dt * 1.5;
    const hit = this.world.castShape(_p, r, dir, this.castBox, 0, reach, false,
      this.R.QueryFilterFlags.EXCLUDE_KINEMATIC | this.R.QueryFilterFlags.EXCLUDE_SENSORS,
      GROUPS.crumpleCast, undefined, b);
    if (!hit) return;
    // normal1/witness1 are in the obstacle collider's local frame
    const cr = hit.collider.rotation(), ct = hit.collider.translation();
    const cq = new THREE.Quaternion(cr.x, cr.y, cr.z, cr.w);
    const n = _n.set(hit.normal1.x, hit.normal1.y, hit.normal1.z).applyQuaternion(cq).normalize();
    if (Math.abs(n.y) > 0.7) return; // floors/ramps are handled by the suspension
    const tb = hit.collider.parent();
    const movable = tb && tb.isDynamic();
    // Movable bodies (wrecks) are left to the solver: its inelastic contact conserves momentum, and an extra
    // cushion impulse on top of a near-zero gap can over-correct and inject energy.
    if (movable && !this.cushionMovable) return;
    const tv = movable ? tb.linvel() : { x: 0, y: 0, z: 0 };
    const vc = -((lv.x - tv.x) * n.x + (lv.y - tv.y) * n.y + (lv.z - tv.z) * n.z); // closing speed into the obstacle
    if (vc <= SAFE_CONTACT) return;
    const dist = Math.max(hit.time_of_impact, 0.03);
    let dv = ((vc * vc - SAFE_CONTACT * SAFE_CONTACT) / (2 * dist)) * dt;
    dv = Math.min(dv, vc - SAFE_CONTACT, MAX_CRUSH_G * 9.81 * dt);
    // Applied through the centre of mass. (The shape-cast witness point is not reliably in a frame we can
    // use, and a far-off application point turns this impulse into a huge torque.) Off-centre hits still yaw
    // the car through the final rigid contact at SAFE_CONTACT speed.
    const com = b.worldCom();
    const w = _F.set(com.x, com.y, com.z);
    // movable targets (wrecked cars): equal and opposite impulse using the reduced mass, so momentum is conserved
    const m = this.spec.mass;
    const mu = movable ? (m * tb.mass()) / (m + tb.mass()) : m;
    const J = mu * dv;
    b.applyImpulseAtPoint({ x: n.x * J, y: 0, z: n.z * J }, w, true);
    if (movable) tb.applyImpulseAtPoint({ x: -n.x * J, y: 0, z: -n.z * J }, w, true);
    this.crumple += dv;
    // contact point for effects: front/rear face of the chassis along -n
    const fx = _tmp.set(-n.x, 0, -n.z).multiplyScalar(2.2);
    this.impact = { dv, point: new THREE.Vector3(com.x + fx.x, 0.5, com.z + fx.z), normal: n.clone(), vc, handle: hit.collider.handle };
  }

  /** Telemetry snapshot for HUD/audio. */
  get telemetry() {
    let slide = 0, spin = 0;
    for (const w of this.wheels) { slide = Math.max(slide, w.contact ? w.slide : 0); spin = Math.max(spin, w.spinSlip); }
    return { speed: this.speed, rpm: this.rpm, gear: this.gear, throttle: this.throttle, brake: this.brake, slide, spin, grounded: this.grounded, engineLoad: this.engineLoad || 0, shifting: this.shiftTimer > 0 };
  }

  isUpsideDown() {
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    return _up.set(0, 1, 0).applyQuaternion(_q).y < 0.2;
  }
}
