// Handling benchmark: stability, drift initiation/hold/recovery and spin-outs per preset and car.
// node scripts/handling-bench.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { VehiclePhysics } from '../src/vehicle/vehiclePhysics.js';
import { SPORTS_CAR, DRIVING_PRESETS } from '../src/vehicle/specs.js';
import { CARS, vehicleSpec } from '../src/career/vehicles.js';

await RAPIER.init();
const dt = 1 / 120;
const deg = (r) => (r * 180) / Math.PI;

export function makeCar(spec, preset, v0) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(3000, 1, 3000).setTranslation(0, -1, 0).setFriction(0.9));
  const car = new VehiclePhysics(RAPIER, world, spec, { preset, position: { x: 0, y: 0.1, z: 0 } });
  for (let i = 0; i < 90; i++) { car.step(dt, { throttle: 0, brake: 0, steer: 0 }); world.step(); }
  car.body.setLinvel({ x: 0, y: 0, z: v0 }, true);
  return { world, car };
}

/** slip angle (deg, + = velocity left of heading) and speed */
export function state(car) {
  const r = car.body.rotation(), v = car.body.linvel();
  const qx = r.x, qy = r.y, qz = r.z, qw = r.w;
  // forward (+Z) and left (+X) in world
  const fx = 2 * (qx * qz + qw * qy), fz = 1 - 2 * (qx * qx + qy * qy);
  const lx = 1 - 2 * (qy * qy + qz * qz), lz = 2 * (qx * qz - qw * qy);
  const vf = v.x * fx + v.z * fz, vl = v.x * lx + v.z * lz;
  return { beta: deg(Math.atan2(vl, Math.abs(vf))), speed: Math.hypot(v.x, v.z), yawRate: car.body.angvel().y };
}

export function run(spec, preset, v0, script, seconds) {
  const { world, car } = makeCar(spec, preset, v0);
  const trace = [];
  for (let i = 0; i < seconds / dt; i++) {
    const t = i * dt;
    car.step(dt, { throttle: 0, brake: 0, steer: 0, handbrake: false, ...script(t) });
    world.step();
    if (i % 3 === 0) trace.push({ t, ...state(car), up: !car.isUpsideDown() });
  }
  return trace;
}

const scenarios = {
  // lane change at 100 km/h: right, left, centre
  laneChange: { v0: 27.8, secs: 4, script: (t) => ({ throttle: 0.4, steer: t < 0.5 ? 0.6 : t < 1.1 ? -0.6 : 0 }) },
  // full lock at 80 km/h with throttle, no handbrake: should push wide, not spin
  fullLock: { v0: 22, secs: 3, script: () => ({ throttle: 0.8, steer: 1 }) },
  // handbrake flick at 70 km/h, then hold with throttle + steering, then let go
  drift: { v0: 19.5, secs: 5, script: (t) => (t < 0.45 ? { steer: 1, handbrake: true, throttle: 0.3 } : t < 2.6 ? { steer: 0.55, throttle: 0.85 } : { steer: 0, throttle: 0.3 }) },
};

function summarise(name, tr) {
  const maxBeta = Math.max(...tr.map((s) => Math.abs(s.beta)));
  const spun = tr.some((s) => Math.abs(s.beta) > 80) || tr.some((s) => !s.up);
  let out = `${name.padEnd(11)} max|beta| ${maxBeta.toFixed(0).padStart(3)}°  spin ${spun ? 'YES' : 'no '}`;
  if (name === 'drift') {
    const hold = tr.filter((s) => s.t > 0.8 && s.t < 2.6);
    const holdBeta = hold.reduce((a, s) => a + Math.abs(s.beta), 0) / hold.length;
    const rec = tr.find((s) => s.t > 2.6 && Math.abs(s.beta) < 5);
    const vHold = hold.length ? hold[hold.length - 1].speed * 3.6 : 0;
    out += `  hold ${holdBeta.toFixed(0)}° @ ${vHold.toFixed(0)} km/h  recovered ${rec ? (rec.t - 2.6).toFixed(2) + ' s' : 'NO'}`;
  }
  if (name === 'laneChange') out += `  final speed ${(tr[tr.length - 1].speed * 3.6).toFixed(0)} km/h`;
  return out;
}

const cars = { sport: SPORTS_CAR, hatch: vehicleSpec(CARS.hatch), suv: vehicleSpec(CARS.suv) };
for (const [presetName, preset] of Object.entries(DRIVING_PRESETS)) {
  for (const [carName, spec] of Object.entries(cars)) {
    console.log(`--- ${presetName} / ${carName}`);
    for (const [name, sc] of Object.entries(scenarios)) console.log('  ' + summarise(name, run(spec, preset, sc.v0, sc.script, sc.secs)));
  }
}
