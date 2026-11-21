import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { VehiclePhysics } from '../src/vehicle/vehiclePhysics.js';
import { SPORTS_CAR, DRIVING_PRESETS } from '../src/vehicle/specs.js';

beforeAll(async () => { await RAPIER.init(); });

function makeWorld() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 1, 2000).setTranslation(0, -1, 0));
  return world;
}

function sim(world, car, seconds, input, dt = 1 / 120) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    car.step(dt, input);
    world.timestep = dt;
    world.step();
  }
}

const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };

for (const presetName of Object.keys(DRIVING_PRESETS)) {
  describe(`vehicle physics (${presetName})`, () => {
    it('settles on its suspension without bouncing away', () => {
      const world = makeWorld();
      const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS[presetName], position: { x: 0, y: 0.4, z: 0 } });
      sim(world, car, 3, idle);
      const y = car.body.translation().y;
      expect(car.grounded).toBe(4);
      expect(y).toBeGreaterThan(-0.15);
      expect(y).toBeLessThan(0.25);
      expect(car.body.linvel().y).toBeLessThan(0.05);
    });

    it('accelerates, shifts up, and brakes to a stop', () => {
      const world = makeWorld();
      const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS[presetName], position: { x: 0, y: 0.2, z: 0 } });
      sim(world, car, 1, idle);
      sim(world, car, 6, { ...idle, throttle: 1 });
      const v = car.speed;
      expect(v).toBeGreaterThan(24); // > 86 km/h after 6 s (sim preset is traction-limited)
      expect(car.gear).toBeGreaterThanOrEqual(2);
      expect(car.isUpsideDown()).toBe(false);
      // hold the brake: the car must come to a stop (it then engages reverse, which is intended)
      let stoppedAt = -1;
      for (let i = 0; i < 7 * 120 && stoppedAt < 0; i++) {
        sim(world, car, 1 / 120, { ...idle, brake: 1 });
        if (Math.abs(car.speed) < 0.3) stoppedAt = i / 120;
      }
      expect(stoppedAt).toBeGreaterThan(0);
      expect(stoppedAt).toBeLessThan(5.5);
    });

    it('turns left/right according to steering input', () => {
      const world = makeWorld();
      const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS[presetName], position: { x: 0, y: 0.2, z: 0 } });
      sim(world, car, 4, { ...idle, throttle: 0.6 });
      sim(world, car, 1.5, { ...idle, throttle: 0.3, steer: 1 }); // right
      const p = car.body.translation();
      // +X is the car's left; a right turn should move it toward -X
      expect(p.x).toBeLessThan(-2);
      expect(car.isUpsideDown()).toBe(false);
    });

    it('reverses when holding brake at standstill', () => {
      const world = makeWorld();
      const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS[presetName], position: { x: 0, y: 0.2, z: 0 } });
      sim(world, car, 1, idle);
      sim(world, car, 3, { ...idle, brake: 1 });
      expect(car.gear).toBe(-1);
      expect(car.speed).toBeLessThan(-2);
    });
  });
}

describe('drift behaviour', () => {
  it('limits speed-induced slip during a full-steering turn in Balanced mode', () => {
    const world = makeWorld();
    const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS.balanced, position: { x: 0, y: 0.2, z: 0 } });
    sim(world, car, 1, idle);
    sim(world, car, 6, { ...idle, throttle: 1 });
    expect(car.speed).toBeGreaterThan(24);

    let maxRearSlide = 0;
    for (let i = 0; i < 60; i++) {
      sim(world, car, 1 / 60, { ...idle, throttle: 0.6, steer: 1 });
      maxRearSlide = Math.max(maxRearSlide, car.wheels[2].slide, car.wheels[3].slide);
    }
    expect(maxRearSlide).toBeLessThan(2);
    expect(car.body.translation().x).toBeLessThan(-1);
  });

  it('handbrake turn at speed produces rear slide', () => {
    const world = makeWorld();
    const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS.balanced, position: { x: 0, y: 0.2, z: 0 } });
    sim(world, car, 5, { ...idle, throttle: 1 });
    let maxSlide = 0;
    for (let i = 0; i < 60; i++) {
      sim(world, car, 1 / 60, { ...idle, throttle: 0.6, steer: -1, handbrake: true });
      maxSlide = Math.max(maxSlide, car.wheels[2].slide, car.wheels[3].slide);
    }
    expect(maxSlide).toBeGreaterThan(2);
    expect(car.isUpsideDown()).toBe(false);
  });
});
