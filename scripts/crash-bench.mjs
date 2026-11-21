import RAPIER from '@dimforge/rapier3d-compat';
import { VehiclePhysics } from '../src/vehicle/vehiclePhysics.js';
import { SPORTS_CAR, DRIVING_PRESETS } from '../src/vehicle/specs.js';
import { GROUPS } from '../src/core/physicsGroups.js';
await RAPIER.init();
const dt = 1/120;
function scenario(name, build, v0 = 25, steer = 0) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1, 0).setFriction(0.9));
  build(world);
  const car = new VehiclePhysics(RAPIER, world, SPORTS_CAR, { preset: DRIVING_PRESETS.balanced, position: { x: 0, y: 0.1, z: -40 } });
  for (let i = 0; i < 120; i++) { car.step(dt, { throttle: 0, brake: 0, steer: 0 }); world.step(); }
  car.body.setLinvel({ x: 0, y: 0, z: v0 }, true);
  let maxAng = 0, maxUp = 0, minVz = 99, events = 0, maxF = 0; const q = new RAPIER.EventQueue(true);
  let impactT = -1, vAfter = null, peakDecel = 0, prevV = v0;
  for (let i = 0; i < 360; i++) {
    car.step(dt, { throttle: 0.0, brake: 0, steer });
    world.step(q);
    q.drainContactForceEvents((e) => { events++; maxF = Math.max(maxF, e.maxForceMagnitude()); if (impactT < 0) impactT = i * dt; });
    const v = car.body.linvel(), a = car.body.angvel();
    maxAng = Math.max(maxAng, Math.hypot(a.x, a.y, a.z)); maxUp = Math.max(maxUp, v.y); minVz = Math.min(minVz, v.z);
    peakDecel = Math.max(peakDecel, (prevV - v.z) / dt / 9.81); prevV = v.z;
    if (impactT >= 0 && vAfter === null && i * dt > impactT + 0.25) vAfter = { ...v };
    if (i === 160 && target) globalThis.__tv = Math.hypot(target.linvel().x, target.linvel().z);
  }
  const p = car.body.translation();
  console.log(name.padEnd(22), 'v0', v0, '| vz@+0.25s', vAfter ? vAfter.z.toFixed(1) : '-', '| min vz', minVz.toFixed(1), '| peak decel g', peakDecel.toFixed(0), '| max angvel', maxAng.toFixed(1), '| max vy', maxUp.toFixed(1), '| upside', car.isUpsideDown(), '| final y', p.y.toFixed(2), '| maxF', (maxF/1000).toFixed(0)+'kN');
}
const wall = (w) => w.createCollider(RAPIER.ColliderDesc.cuboid(10, 3, 0.5).setTranslation(0, 3, 0).setFriction(0.7));
const pole = (w) => w.createCollider(RAPIER.ColliderDesc.cylinder(1.5, 0.14).setTranslation(0.4, 1.5, 0).setFriction(0.6));
const angled = (w) => { const d = RAPIER.ColliderDesc.cuboid(10, 3, 0.5).setTranslation(0, 3, 0).setFriction(0.7); const a = 0.35; d.setRotation({ x: 0, y: Math.sin(a/2), z: 0, w: Math.cos(a/2) }); w.createCollider(d); };
const curb = (w) => w.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.075, 10).setTranslation(0, 0.075, 10.5).setFriction(0.7));
const npc = (w) => { const b = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0.3, 0, 2)); w.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.62, 2.3).setTranslation(0, 0.78, 0), b); };
const side = (w) => { const b = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 2).setRotation({x:0,y:Math.sin(Math.PI/4),z:0,w:Math.cos(Math.PI/4)})); w.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.62, 2.3).setTranslation(0, 0.78, 0), b); };
let target = null;
const dyn = (w, rot = 0) => { const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.02, 2).setRotation({x:0,y:Math.sin(rot/2),z:0,w:Math.cos(rot/2)})); w.createCollider(RAPIER.ColliderDesc.roundCuboid(0.8, 0.52, 2.15, 0.1).setTranslation(0, 0.78, 0).setMass(1350).setFriction(0.3).setCollisionGroups(GROUPS.npc), b); w.createCollider(RAPIER.ColliderDesc.ball(0.33).setTranslation(0, 0.33, 0).setDensity(0).setFriction(0.0), b); target = b; };
scenario('wall head-on 90kmh', wall);
scenario('wall head-on 30kmh', wall, 8.3);
scenario('wall 20deg glance', angled);
scenario('pole 90kmh', pole);
scenario('curb 90kmh', curb);
scenario('kinematic npc rear', npc);
scenario('kinematic npc t-bone', side);
scenario('dynamic car rear 90kmh', (w) => dyn(w));
console.log('   target car speed after:', Math.hypot(target.linvel().x, target.linvel().z).toFixed(1), 'm/s');
scenario('dynamic car t-bone', (w) => dyn(w, Math.PI / 2));
console.log('   target car speed after:', Math.hypot(target.linvel().x, target.linvel().z).toFixed(1), 'm/s');
