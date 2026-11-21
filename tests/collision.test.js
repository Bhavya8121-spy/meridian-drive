import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { VehiclePhysics } from '../src/vehicle/vehiclePhysics.js';
import { SPORTS_CAR, DRIVING_PRESETS } from '../src/vehicle/specs.js';
import { GROUPS } from '../src/core/physicsGroups.js';

beforeAll(async () => { await RAPIER.init(); });
const dt = 1 / 120;

/** Drive the car at v0 (m/s, +Z) into whatever `build` places near z = 0 and record the response. */
function crash(build, v0 = 25) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setFriction(0.9));
  const extra = build(world);
  const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS.balanced, position: { x: 0, y: 0.1, z: -40 } });
  const idle = { throttle: 0, brake: 0, steer: 0 };
  for (let i = 0; i < 120; i++) { car.step(dt, idle); world.step(); }
  car.body.setLinvel({ x: 0, y: 0, z: v0 }, true);
  let peakG = 0, minVz = Infinity, maxAng = 0, prev = v0;
  for (let i = 0; i < 300; i++) {
    car.step(dt, idle); world.step();
    const v = car.body.linvel(), a = car.body.angvel();
    peakG = Math.max(peakG, (prev - v.z) / dt / 9.81); prev = v.z;
    minVz = Math.min(minVz, v.z);
    maxAng = Math.max(maxAng, Math.hypot(a.x, a.y, a.z));
  }
  return { car, world, extra, peakG, minVz, maxAng, v: car.body.linvel() };
}

describe('collision response', () => {
  it('head-on into a wall at 90 km/h decelerates over a crush distance without bouncing back', () => {
    const r = crash((w) => w.createCollider(RAPIER.ColliderDesc.cuboid(10, 3, 0.5).setTranslation(0, 3, 0)));
    expect(r.peakG).toBeLessThan(120);        // was ~320 g with purely rigid contacts
    expect(r.minVz).toBeGreaterThan(-0.6);    // no rebound
    expect(r.car.isUpsideDown()).toBe(false);
  });

  it('glancing a wall slides along it instead of spinning out', () => {
    const r = crash((w) => {
      const a = 0.35;
      w.createCollider(RAPIER.ColliderDesc.cuboid(10, 3, 0.5).setTranslation(0, 3, 0).setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }));
    });
    expect(r.maxAng).toBeLessThan(3.5);
    expect(r.car.isUpsideDown()).toBe(false);
  });

  it('rear-ending a movable car exchanges momentum without gaining energy', () => {
    const r = crash((w) => {
      const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.02, 2));
      w.createCollider(RAPIER.ColliderDesc.roundCuboid(0.8, 0.52, 2.15, 0.1).setTranslation(0, 0.78, 0).setMass(1350).setCollisionGroups(GROUPS.npc), b);
      w.createCollider(RAPIER.ColliderDesc.ball(0.33).setTranslation(0, 0.33, 0).setDensity(0).setFriction(0), b);
      return b;
    });
    const vt = Math.hypot(r.extra.linvel().x, r.extra.linvel().z);
    const vp = Math.hypot(r.v.x, r.v.z);
    expect(vt).toBeGreaterThan(1); // the other car got shoved
    // inelastic: kinetic energy after <= before (no solver explosion)
    const before = 0.5 * 1480 * 25 * 25, after = 0.5 * 1480 * vp * vp + 0.5 * 1350 * vt * vt;
    expect(after).toBeLessThan(before);
    expect(r.car.isUpsideDown()).toBe(false);
  });

  it('crashing into a wall far from the world origin does not fling the car (regression)', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(-170, -1, -200));
    world.createCollider(RAPIER.ColliderDesc.cuboid(8, 10, 8).setTranslation(-170, 10, -183));
    const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS.balanced, position: { x: -170, y: 0.1, z: -215 } });
    for (let i = 0; i < 60; i++) { car.step(dt, { throttle: 0, brake: 0, steer: 0 }); world.step(); }
    car.body.setLinvel({ x: 0, y: 0, z: 25 }, true);
    let maxSpeed = 0;
    for (let i = 0; i < 240; i++) {
      car.step(dt, { throttle: 0, brake: 0, steer: 0 }); world.step();
      const v = car.body.linvel();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
    }
    const p = car.body.translation();
    expect(maxSpeed).toBeLessThan(26);
    expect(Math.abs(p.z + 193.3)).toBeLessThan(1.5); // stopped against the face at z = -191
  });

  it('suspension ignores debris (no riding up on knocked-over props)', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.cuboid(50, 1, 50).setTranslation(0, -1, 0));
    // a debris box directly under the front-left wheel
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.12, 0.3).setTranslation(0.82, 0.12, 1.33).setCollisionGroups(GROUPS.debris));
    const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS.balanced, position: { x: 0, y: 0.1, z: 0 } });
    for (let i = 0; i < 120; i++) { car.step(dt, { throttle: 0, brake: 0, steer: 0 }); world.step(); }
    expect(car.wheels[0].len).toBeGreaterThan(car.wheels[1].len - 0.05);
  });
});
