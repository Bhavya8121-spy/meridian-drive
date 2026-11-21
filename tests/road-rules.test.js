import { beforeAll, describe, expect, it } from 'vitest';
import { buildLayout } from '../src/world/layout.js';
import { RoadRules, SPEED_LIMIT, speedLimitAt, impactInvoice } from '../src/career/road-rules.js';
import { buildCareerCity } from '../src/career/city.js';
import { Career } from '../src/career/career.js';
import { CHARGE_PRICE, HOME_CHARGE_PRICE, FUEL_PRICE, litersPerKm } from '../src/career/vehicles.js';

let layout;
beforeAll(() => { layout = buildLayout(1337); });

describe('road enforcement', () => {
  it('debounces speeding while allowing the driver to reach the cruising speed', () => {
    const rules = new RoadRules();
    const charges = [];
    const pos = { x: 0, z: 0, y: 0 };
    const record = (...item) => charges.push(item);
    for (let i = 0; i < 30; i++) rules.update(0.1, pos, 0, SPEED_LIMIT, 0, record);
    expect(charges).toHaveLength(0);
    for (let i = 0; i < 30; i++) rules.update(0.1, pos, 0, 94, 0, record);
    expect(charges).toEqual([['Speeding', 9]]);
  });

  it('only enforces the speed limit on city streets', () => {
    const rules = new RoadRules();
    const charges = [];
    const record = (...item) => charges.push(item);
    const ring = { x: 520, z: 0, y: 0 }, deck = { x: 300, z: 0, y: 8.5 };
    for (let i = 0; i < 30; i++) rules.update(0.1, ring, 0, 140, 0, record);
    for (let i = 0; i < 30; i++) rules.update(0.1, deck, 0, 140, 0, record);
    expect(charges).toHaveLength(0);
    expect(speedLimitAt({ x: 100, z: -200, y: 0 })).toBe(SPEED_LIMIT);
    expect(speedLimitAt(ring)).toBeNull();
  });

  it('no longer fines red lights or stop signs', () => {
    const rules = new RoadRules();
    const charges = [];
    const record = (...item) => charges.push(item);
    const red = layout.intersections.find((j) => j.type === 'signal');
    for (let i = 0; i < 20; i++) rules.update(0.1, { x: red.x - 10 + i, z: red.z, y: 0 }, Math.PI / 2, 40, 0, record);
    expect(charges).toHaveLength(0);
  });
});

describe('repair and EV charging', () => {
  it('tracks liability and repair separately and restores vehicle condition', () => {
    const career = new Career(buildCareerCity(layout), { storage: null });
    const damage = impactInvoice('vehicle', 0.4);
    career.recordDamage(damage.wear);
    career.charge(damage.label, damage.cost);
    const quote = career.repairCost;
    expect(quote).toBeGreaterThan(0);
    expect(career.repair()).toBe(true);
    expect(career.vehicle.damage).toBe(0);
    expect(career.profile.balance).toBe(90 - damage.cost - quote);
    expect(career.profile.roadCosts).toBe(damage.cost);
  });

  it('routes EVs to chargers, bills in kWh, and offers cheaper home charging', () => {
    const city = buildCareerCity(layout);
    const career = new Career(city, { storage: null });
    career.profile.balance = 900;
    expect(career.selectCar('electric')).toBe(true);
    expect(city.chargers).toHaveLength(8);
    expect(career.electric).toBe(true);
    expect(career.car.kwhKm * CHARGE_PRICE).toBeLessThan(litersPerKm(25) * FUEL_PRICE);
    career.navigate('fuel', city.home);
    expect(career.target.type).toBe('charge');
    const before = career.profile.balance;
    const missing = career.capacity - career.vehicle.fuel;
    expect(career.refuel()).toBe(true);
    expect(career.profile.balance).toBeCloseTo(before - missing * CHARGE_PRICE);
    career.vehicle.fuel -= 10;
    expect(career.refuel(true)).toBe(false);
    expect(career.buy('homeCharger')).toBe(true);
    const afterInstall = career.profile.balance;
    expect(career.refuel(true)).toBe(true);
    expect(career.profile.balance).toBeCloseTo(afterInstall - 10 * HOME_CHARGE_PRICE);
  });
});
