import { SPORTS_CAR } from '../vehicle/specs.js';
import { BODY_TYPES } from '../vehicle/carModel.js';

// Representative city mileage in US MPG. Each fictional vehicle uses its own tank and powertrain.
export const CARS = {
  hatch: { name: 'Alder Hatch', type: 'hatch', price: 0, mpg: 25, tank: 42, power: 0.30, grip: 0.86, mass: 1220, color: '#888d91' },
  sedan: { name: 'Union Hybrid', type: 'sedan', price: 320, mpg: 49, tank: 43, power: 0.53, grip: 1, mass: 1450, color: '#165f62' },
  suv: { name: 'Foundry XL', type: 'suv', price: 650, mpg: 21, tank: 66, power: 0.76, grip: 0.96, mass: 1930, color: '#183858' },
  electric: { name: 'Orchard E', type: 'hatch', price: 480, battery: 52, kwhKm: 0.158, power: 0.54, grip: 1.02, mass: 1520, color: '#416a92' },
  electricXL: { name: 'Foundry E-XL', type: 'suv', price: 860, battery: 76, kwhKm: 0.215, power: 0.72, grip: 1.03, mass: 2050, color: '#7b7463' },
  sport: { name: 'Meridian GT', type: 'sport', price: 980, mpg: 17, tank: 60, power: 1, grip: 1.06, mass: 1480, color: '#a92b36' },
};
/** Per body type dimension overrides (set when an imported car model replaces the procedural body). */
export const BODY_OVERRIDES = {};
export const ROBOT_PRICE = 3200;
export const HIRE_PRICE = 180;
export const FUEL_PRICE = 1.08;
export const CHARGE_PRICE = 0.22;
export const HOME_CHARGE_PRICE = 0.13;
export const HOME_CHARGER_COST = 115;
export const capacity = (car) => car.battery ?? car.tank;
export const energyUnit = (car) => car.battery ? 'kWh' : 'L';
export const litersPerKm = (mpg) => 2.35214583 / mpg;

export function vehicleSpec(car, upgrade = 0) {
  const body = { ...BODY_TYPES[car.type], ...BODY_OVERRIDES[car.type] };
  const massScale = car.mass / SPORTS_CAR.mass;
  const power = car.power * (1 + 0.12 * upgrade);
  const x = body.W / 2 - 0.16;
  return {
    ...SPORTS_CAR, name: car.name, mass: car.mass, wheelRadius: body.r, maxSpeed: 110 / 3.6,
    ...(car.battery ? { gears: [2.7], finalDrive: 3.1, electric: true } : {}),
    mountY: SPORTS_CAR.mountY + body.r - SPORTS_CAR.wheelRadius,
    wheelWidth: car.type === 'hatch' ? 0.20 : car.type === 'sedan' ? 0.225 : 0.27,
    inertia: Object.fromEntries(Object.entries(SPORTS_CAR.inertia).map(([k, value]) => [k, value * massScale])),
    springFront: SPORTS_CAR.springFront * massScale, springRear: SPORTS_CAR.springRear * massScale,
    wheels: [body.wf, body.wr].flatMap((z, i) => [x, -x].map((x) => ({ x, z, front: i === 0 }))),
    chassis: { width: body.W, length: body.L, roof: body.roofY },
    engine: { ...SPORTS_CAR.engine, torque: SPORTS_CAR.engine.torque.map(([rpm, torque]) => [rpm, torque * power]) },
  };
}
