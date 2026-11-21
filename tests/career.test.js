import { beforeAll, describe, expect, it } from 'vitest';
import { buildLayout, SURF } from '../src/world/layout.js';
import { buildCareerCity, distance, routeDistance } from '../src/career/city.js';
import { Career } from '../src/career/career.js';
import { CARS, FUEL_PRICE, litersPerKm, vehicleSpec } from '../src/career/vehicles.js';

let layout, city;
beforeAll(() => {
  layout = buildLayout(1337);
  city = buildCareerCity(layout);
});

function model(random = () => 0.6, storage = null) {
  return new Career(city, { storage, random });
}

function stopAt(career, stop, damage = 0) {
  for (let i = 0; i < 10; i++) career.update(0.1, stop, 0, 0, 0, damage);
}

describe('driver career', () => {
  it('places distinct addresses, service stations and checkpoints on the city grid', () => {
    expect(city.stops.length).toBe(288);
    expect(new Set(city.stops.map((s) => s.address)).size).toBe(city.stops.length);
    expect(city.stations).toHaveLength(8);
    for (const stop of city.stops) {
      expect(layout.surfaceAt(stop.x, stop.z)).toBe(SURF.ROAD);
      expect(Number.isFinite(routeDistance(city.route(city.home, stop)))).toBe(true);
    }
    const end = city.stops.at(-1);
    expect(city.route(city.home, end).at(-1)).toBe(end);
  });

  it('offers close pickups, changes destinations by shift and increases fares in rain', () => {
    const career = model();
    const morning = career.offerRide(city.home, 0);
    const rainy = career.offerRide(city.home, 0.8);
    expect(distance(city.home, city.stops[morning.pickup])).toBeLessThan(160);
    expect(['work', 'coffee', 'leisure']).toContain(city.stops[morning.dropoff].type);
    expect(rainy.fare).toBeGreaterThan(morning.fare);
    career.profile.hours = 22;
    const night = career.offerRide(city.home, 0);
    expect(['nightlife', 'home']).toContain(city.stops[night.dropoff].type);
    expect(night.surge).toBeGreaterThan(morning.surge);
  });

  it('can decline a job, then pays once after the rider boards and is dropped off', () => {
    const career = model();
    career.offer = career.offerRide(city.home, 0);
    career.decline();
    expect(career.offer).toBeNull();
    career.offer = career.offerRide(city.home, 0);
    const job = career.offer;
    career.accept();
    expect(career.target.id).toBe(job.pickup);
    career.update(1, career.target, 8, 0.2, 0, 0);
    expect(career.ride.phase).toBe('pickup');
    stopAt(career, career.target);
    expect(career.target.id).toBe(job.dropoff);
    stopAt(career, career.target);
    stopAt(career, city.stops[job.dropoff]);
    expect(career.profile.balance).toBe(90 + job.fare);
    expect(career.profile.completed).toBe(1);
  });

  it('handles scenic checkpoints and rewards clean thrill rides', () => {
    const scenic = model(() => 0.05);
    scenic.offer = scenic.offerRide(city.home, 0);
    const job = scenic.offer;
    expect(job.kind).toBe('tour');
    expect(job.scenic).not.toBeNull();
    scenic.accept();
    stopAt(scenic, scenic.target);
    expect(scenic.target.id).toBe(job.scenic);
    stopAt(scenic, scenic.target);
    expect(scenic.target.id).toBe(job.dropoff);
    expect(scenic.profile.completed).toBe(0);
    stopAt(scenic, scenic.target);
    expect(scenic.profile.completed).toBe(1);

    const express = model(() => 0.2);
    express.offer = express.offerRide(city.home, 0);
    const fare = express.offer.fare;
    express.accept();
    stopAt(express, express.target);
    express.update(0.1, city.home, 17, 0.7, 0, 0);
    stopAt(express, express.target);
    expect(express.profile.balance).toBe(90 + fare + 25);
  });

  it('uses tank-specific fuel and charges only for fuel added', () => {
    const career = model();
    expect(litersPerKm(25)).toBeCloseTo(0.094, 3);
    career.update(0.1, city.home, 15, 0, 0, 0);
    career.update(0.1, { x: city.home.x + 1.5, z: city.home.z }, 15, 0, 0, 0);
    expect(career.vehicle.fuel).toBeLessThan(8);
    const missing = career.car.tank - career.vehicle.fuel;
    expect(career.refuel()).toBe(true);
    expect(career.vehicle.fuel).toBe(career.car.tank);
    expect(career.profile.balance).toBeCloseTo(90 - missing * FUEL_PRICE);
    expect(career.refuel()).toBe(false);
  });

  it('saves car choices and applies different power and geometry across the catalog', () => {
    const memory = new Map();
    const storage = { getItem: (key) => memory.get(key), setItem: (key, value) => memory.set(key, value) };
    const career = model(undefined, storage);
    expect(career.selectCar('sedan')).toBe(false);
    career.profile.balance = 800;
    const oldFuel = career.vehicle.fuel;
    expect(career.selectCar('sedan')).toBe(true);
    expect(career.buy('car')).toBe(true);
    const restored = model(undefined, storage);
    expect(restored.profile.car).toBe('sedan');
    expect(restored.vehicle.level).toBe(1);
    expect(restored.profile.owned.hatch.fuel).toBe(oldFuel);
    expect(vehicleSpec(CARS.suv).wheelRadius).toBeGreaterThan(vehicleSpec(CARS.hatch).wheelRadius);
    expect(vehicleSpec(CARS.sedan, 1).engine.torque[3][1]).toBeGreaterThan(vehicleSpec(CARS.sedan).engine.torque[3][1]);
  });

  it('restores energy with eight hours of sleep and pays fleet income at midnight', () => {
    const career = model();
    career.profile.balance = 5000;
    expect(career.buy('hire')).toBe(true);
    expect(career.buy('robot')).toBe(true);
    expect(career.buy('endurance')).toBe(true);
    career.advance(12);
    const before = career.profile.balance;
    expect(career.profile.drivers[0].worked).toBe(12);
    career.profile.awake = 12;
    career.rest();
    expect(career.time).toBeCloseTo(3.5);
    expect(career.energy).toBe(1);
    expect(career.profile.balance - before).toBeCloseTo(340);
    expect(career.profile.drivers[0].resting).toBeCloseTo(4);
  });
});
