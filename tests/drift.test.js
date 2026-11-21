import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { VehiclePhysics } from '../src/vehicle/vehiclePhysics.js';
import { SPORTS_CAR, DRIVING_PRESETS } from '../src/vehicle/specs.js';
import { CARS, vehicleSpec } from '../src/career/vehicles.js';

beforeAll(async () => { await RAPIER.init(); });
const dt = 1 / 120;

function run(spec, preset, v0, script, seconds) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(3000, 1, 3000).setTranslation(0, -1, 0).setFriction(0.9));
  const car = new VehiclePhysics(RAPIER, world, spec, { preset, position: { x: 0, y: 0.1, z: 0 } });
  for (let i = 0; i < 90; i++) { car.step(dt, { throttle: 0, brake: 0, steer: 0 }); world.step(); }
  car.body.setLinvel({ x: 0, y: 0, z: v0 }, true);
  const trace = [];
  for (let i = 0; i < seconds / dt; i++) {
    car.step(dt, { throttle: 0, brake: 0, steer: 0, handbrake: false, ...script(i * dt) });
    world.step();
    const r = car.body.rotation(), v = car.body.linvel();
    const fx = 2 * (r.x * r.z + r.w * r.y), fz = 1 - 2 * (r.x * r.x + r.y * r.y);
    const lx = 1 - 2 * (r.y * r.y + r.z * r.z), lz = 2 * (r.x * r.z - r.w * r.y);
    const beta = (Math.atan2(v.x * lx + v.z * lz, Math.abs(v.x * fx + v.z * fz)) * 180) / Math.PI;
    trace.push({ t: i * dt, beta, speed: Math.hypot(v.x, v.z), upright: !car.isUpsideDown() });
  }
  return trace;
}

// handbrake flick at 70 km/h, hold with throttle + steering, then centre the wheel
const drift = (t) => (t < 0.45 ? { steer: 1, handbrake: true, throttle: 0.3 } : t < 2.6 ? { steer: 0.55, throttle: 0.85 } : { steer: 0, throttle: 0.3 });

for (const presetName of ['arcade', 'balanced']) {
  for (const [carName, spec] of [['sport', SPORTS_CAR], ['hatch', vehicleSpec(CARS.hatch)], ['suv', vehicleSpec(CARS.suv)]]) {
    describe(`drift assist (${presetName}, ${carName})`, () => {
      let cached;
      const trace = () => (cached ||= run(spec, DRIVING_PRESETS[presetName], 19.5, drift, 4));
      it('holds a controllable drift angle without spinning out', () => {
        const tr = trace();
        const hold = tr.filter((s) => s.t > 0.8 && s.t < 2.6);
        const mean = hold.reduce((a, s) => a + Math.abs(s.beta), 0) / hold.length;
        expect(mean).toBeGreaterThan(25);
        expect(mean).toBeLessThan(50);
        expect(Math.max(...tr.map((s) => Math.abs(s.beta)))).toBeLessThan(62);
        expect(tr.every((s) => s.upright)).toBe(true);
      });
      it('keeps useful speed through the drift', () => {
        const atEnd = trace().find((s) => s.t >= 2.55);
        expect(atEnd.speed * 3.6).toBeGreaterThan(20);
      });
      it('straightens within a second of centring the steering', () => {
        const rec = trace().find((s) => s.t > 2.6 && Math.abs(s.beta) < 5);
        expect(rec).toBeDefined();
        expect(rec.t - 2.6).toBeLessThan(1);
      });
    });
  }
}

describe('everyday stability', () => {
  for (const presetName of ['arcade', 'balanced', 'simulation']) {
    it(`a 100 km/h lane change stays composed (${presetName})`, () => {
      const tr = run(vehicleSpec(CARS.hatch), DRIVING_PRESETS[presetName], 27.8, (t) => ({ throttle: 0.4, steer: t < 0.5 ? 0.6 : t < 1.1 ? -0.6 : 0 }), 4);
      expect(Math.max(...tr.map((s) => Math.abs(s.beta)))).toBeLessThan(25);
    });
  }
});
