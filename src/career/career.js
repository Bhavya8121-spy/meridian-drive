import { CARS, FUEL_PRICE, CHARGE_PRICE, HOME_CHARGE_PRICE, HOME_CHARGER_COST, HIRE_PRICE, ROBOT_PRICE, capacity, energyUnit, litersPerKm } from './vehicles.js';
import { distance, routeDistance } from './city.js';

const KEY = 'meridian-rides-v1';
const newProfile = () => ({
  balance: 90, car: 'hatch', owned: { hatch: { fuel: 8, level: 0 } },
  hours: 7.5, awake: 0, endurance: 0, drivers: [], robots: 0, completed: 0, service: null, ride: null,
});
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
export const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);
export const upgradePrice = (level) => 85 + level * 75;
export const shiftLength = (driver) => 16 + driver.level * 2;

function workFleet(drivers, hours) {
  for (const driver of drivers) {
    let remaining = hours;
    while (remaining > 0.000001) {
      if (driver.resting > 0) {
        const rest = Math.min(driver.resting, remaining);
        driver.resting -= rest;
        remaining -= rest;
        continue;
      }
      const shift = shiftLength(driver);
      const work = Math.min(shift - driver.awake, remaining);
      driver.awake += work;
      driver.worked += work;
      remaining -= work;
      if (driver.awake >= shift) {
        driver.awake = 0;
        driver.resting = 8;
      }
    }
  }
}

export class Career {
  constructor(city, { storage = globalThis.localStorage, random = Math.random } = {}) {
    this.city = city;
    this.storage = storage;
    this.random = random;
    this.profile = newProfile();
    try {
      const saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
      if (saved?.owned?.[saved.car] && CARS[saved.car]) Object.assign(this.profile, saved);
      for (const driver of this.profile.drivers) {
        driver.awake ??= Math.min(driver.worked, shiftLength(driver));
        driver.resting ??= 0;
      }
    } catch { /* A fresh profile works without browser storage. */ }
    this.offer = null;
    this.offerIn = 1;
    this.routeIn = 0;
    this.saveIn = 0;
    this.route = [];
    this.notice = '';
    this.ledgerBalance = this.profile.balance;
  }

  get car() { return CARS[this.profile.car]; }
  get vehicle() { return this.profile.owned[this.profile.car]; }
  get electric() { return Boolean(this.car.battery); }
  get capacity() { return capacity(this.car); }
  get unit() { return energyUnit(this.car); }
  get repairCost() {
    const wear = this.vehicle.damage ?? 0;
    return wear > 0.001 ? Math.ceil(2 + wear * 65) : 0;
  }

  recordDamage(wear) {
    this.vehicle.damage = clamp(wear, 0, 1);
  }

  charge(label, amount) {
    this.profile.balance -= amount;
    this.profile.incidents = (this.profile.incidents ?? 0) + 1;
    this.profile.roadCosts = (this.profile.roadCosts ?? 0) + amount;
    if (this.ride) this.ride.cited = true;
    this.notice = `${label} · −${money(amount)}`;
    this.save();
  }

  repair() {
    const cost = this.repairCost;
    if (!cost || this.profile.balance < cost) return false;
    this.profile.balance -= cost;
    this.recordDamage(0);
    this.notice = `Vehicle repaired · ${money(cost)}`;
    this.save();
    return true;
  }

  get time() { return this.profile.hours % 24; }
  get energy() { return clamp(1 - this.profile.awake / (15 + this.profile.endurance * 2), 0, 1); }
  get ride() { return this.profile.ride; }
  get target() {
    const { service, ride } = this.profile;
    if (service !== null) return this.city.stops[service];
    if (ride) return this.city.stops[ride.phase === 'pickup' ? ride.pickup : ride.scenic ?? ride.dropoff];
    return null;
  }

  /** Wallet history: every balance change, labelled with the notice that explains it (newest first, 30 kept). */
  trackLedger() {
    const p = this.profile, delta = p.balance - this.ledgerBalance;
    if (Math.abs(delta) > 0.004) {
      const label = (this.notice || (delta > 0 ? 'Payment' : 'Payment sent')).split(' · ')[0].replace(/[.]$/, '');
      (p.ledger ||= []).unshift({ label, amount: Math.round(delta * 100) / 100, hours: p.hours % 24 });
      p.ledger.length = Math.min(p.ledger.length, 30);
    }
    this.ledgerBalance = p.balance;
  }

  save() {
    this.trackLedger();
    try { this.storage?.setItem(KEY, JSON.stringify(this.profile)); } catch { /* Storage is optional. */ }
  }

  advance(hours) {
    const p = this.profile;
    let remaining = hours;
    while (remaining > 0) {
      const toMidnight = 24 - p.hours % 24;
      const interval = Math.min(toMidnight, remaining);
      workFleet(p.drivers, interval);
      p.hours += interval;
      remaining -= interval;
      if (interval < toMidnight) break;
      const payout = p.drivers.reduce((total, driver) => {
        const earned = driver.worked * (5 + driver.level * 1.25);
        driver.worked = 0;
        return total + earned;
      }, 0) + p.robots * 260;
      p.balance += payout;
      if (payout) this.notice = `Daily fleet payout · ${money(payout)}`;
      this.save();
    }
  }

  offerRide(pos, wet) {
    const pick = (items) => items[Math.floor(this.random() * items.length)];
    const stops = this.city.stops.filter((s) => !['base', 'fuel', 'charge'].includes(s.type));
    const h = this.time;
    const night = h >= 19 || h < 5;
    const morning = h >= 5 && h < 11;
    const origins = night ? ['work', 'nightlife', 'home', 'leisure'] : morning ? ['home', 'coffee'] : ['work', 'coffee', 'leisure', 'home'];
    const destinations = night ? ['nightlife', 'home'] : morning ? ['work', 'coffee', 'leisure'] : ['work', 'leisure', 'coffee', 'home'];
    const ranked = stops.filter((s) => origins.includes(s.type)).sort((a, b) => distance(a, pos) - distance(b, pos));
    const pickup = pick(ranked.slice(0, 7));
    const variant = this.random();
    const kind = variant < 0.12 ? 'tour' : variant < 0.27 ? 'express' : 'regular';
    const min = kind === 'tour' ? 380 : 115;
    const max = kind === 'tour' ? 700 : 370;
    const nearby = stops.filter((s) => destinations.includes(s.type) && distance(s, pickup) >= min && distance(s, pickup) <= max && (kind !== 'tour' || ['leisure', 'nightlife'].includes(s.type)));
    const dropoff = pick(nearby.length ? nearby : stops.filter((s) => distance(s, pickup) > 100 && distance(s, pickup) < 370));
    const sightseeing = kind === 'tour' ? nearby.filter((s) => s.id !== dropoff.id && distance(s, dropoff) >= 110 && distance(s, dropoff) <= 350) : [];
    const scenic = sightseeing.length ? pick(sightseeing) : null;
    const km = scenic
      ? (routeDistance(this.city.route(pickup, scenic)) + routeDistance(this.city.route(scenic, dropoff))) / 1000
      : routeDistance(this.city.route(pickup, dropoff)) / 1000;
    const peak = (h >= 7 && h < 10) || (h >= 16 && h < 19);
    const surge = 1 + (night ? 0.32 : peak ? 0.20 : 0) + Math.min(0.45, wet * 0.55);
    const fare = Math.round((26 + km * 22 + (kind === 'tour' ? 22 : 0)) * surge);
    const rider = pick(['Avery', 'Jordan', 'Sam', 'Morgan', 'Casey', 'Jamie', 'Riley', 'Taylor', 'Devin', 'Alex']);
    return { pickup: pickup.id, dropoff: dropoff.id, scenic: scenic?.id ?? null, rider, kind, fare, surge, km, seconds: 25 };
  }

  update(dt, pos, speed, engineLoad, wet, damage) {
    const p = this.profile;
    const hours = dt / 30;
    p.awake += hours;
    this.advance(hours);
    const meters = this.lastPos ? Math.min(distance(pos, this.lastPos), Math.abs(speed) * dt * 1.6 + 0.25) : 0;
    this.lastPos = { x: pos.x, z: pos.z };
    p.location = this.lastPos;
    const perKm = this.electric ? this.car.kwhKm : litersPerKm(this.car.mpg);
    this.vehicle.fuel = Math.max(0, this.vehicle.fuel - meters / 1000 * perKm * (1 + Math.max(0, engineLoad) * 0.3) - dt * (this.electric ? 0.1 : 0.65) / 3600);
    const ride = this.ride;
    const target = this.target;
    if (target && (this.routeIn -= dt) <= 0) {
      this.routeIn = 0.7;
      this.route = this.city.route(pos, target);
    }
    if (ride && p.service === null) {
      if (ride.phase === 'dropoff') {
        ride.secondsDriving += dt;
        ride.peak = Math.max(ride.peak, Math.abs(speed) * 3.6);
        ride.damage = Math.max(ride.damage, damage - ride.startDamage);
      }
      if (distance(pos, target) < 5.5 && Math.abs(speed) < 1.5) {
        ride.stopped += dt;
        if (ride.stopped >= 0.85) this.arrive(damage);
      } else ride.stopped = 0;
    }
    if (this.offer) {
      this.offer.seconds -= dt;
      if (this.offer.seconds <= 0) this.decline();
    } else if (!ride && p.service === null && this.energy > 0.07 && this.vehicle.fuel > 0 && (this.offerIn -= dt) <= 0) {
      this.offer = this.offerRide(pos, wet);
    }
    if ((this.saveIn -= dt) <= 0) { this.saveIn = 4; this.save(); }
  }

  accept() {
    if (!this.offer || this.ride || this.target) return;
    this.profile.ride = { ...this.offer, phase: 'pickup', stopped: 0, secondsDriving: 0, peak: 0, damage: 0 };
    this.offer = null;
    this.routeIn = 0;
    this.notice = 'Drive to the pickup and stop inside the marker.';
    this.save();
  }

  decline() {
    this.offer = null;
    this.offerIn = 3;
  }

  cancelRide() {
    if (!this.ride) return;
    this.profile.ride = null;
    this.route = [];
    this.offerIn = 3;
    this.notice = 'Ride cancelled';
    this.save();
  }

  arrive(damage) {
    const ride = this.ride;
    this.route = [];
    this.routeIn = 0;
    if (ride.phase === 'pickup') {
      ride.phase = 'dropoff';
      ride.startDamage = damage;
      ride.stopped = 0;
      this.notice = `${ride.rider} boarded. Follow the blue route.`;
    } else if (ride.scenic !== null && ride.scenic !== undefined) {
      ride.scenic = null;
      ride.stopped = 0;
      this.notice = 'Scenic stop complete. Continue to the destination.';
    } else {
      const bonus = ride.kind === 'express' && ride.peak >= 58 && ride.peak <= 80.5 && ride.damage < 0.04 && !ride.cited ? 25 : 0;
      this.profile.balance += ride.fare + bonus;
      this.profile.completed++;
      this.profile.ride = null;
      this.offerIn = 3;
      this.notice = `Ride completed · ${money(ride.fare + bonus)}${bonus ? ' including express bonus' : ''}`;
    }
    this.save();
  }

  navigate(type, pos) {
    if (this.ride && type === 'home') return;
    const candidates = type === 'home' ? [this.city.home] : this.electric ? this.city.chargers : this.city.stations;
    this.profile.service = candidates.reduce((best, stop) => distance(stop, pos) < distance(best, pos) ? stop : best).id;
    this.decline();
    this.route = [];
    this.routeIn = 0;
    this.save();
  }

  clearNavigation() {
    this.profile.service = null;
    this.route = [];
    this.routeIn = 0;
    this.save();
  }

  serviceAt(pos, speed) {
    if (Math.abs(speed) >= 1.5) return null;
    return [this.city.home, ...(this.electric ? this.city.chargers : this.city.stations)].find((s) => distance(s, pos) < 6) ?? null;
  }

  refuel(atHome = false) {
    const p = this.profile;
    if (atHome && (!this.electric || !p.homeCharger)) return false;
    const price = atHome ? HOME_CHARGE_PRICE : this.electric ? CHARGE_PRICE : FUEL_PRICE;
    const amount = Math.min(this.capacity - this.vehicle.fuel, p.balance / price);
    if (amount < 0.01) return false;
    this.vehicle.fuel += amount;
    p.balance -= amount * price;
    p.service = null;
    this.route = [];
    this.routeIn = 0;
    this.notice = `Added ${amount.toFixed(1)} ${this.unit} · ${money(amount * price)}`;
    this.save();
    return true;
  }

  rest() {
    this.profile.awake = 0;
    this.notice = '';
    this.decline();
    this.advance(8);
    this.profile.service = null;
    this.route = [];
    this.notice = this.notice.startsWith('Daily fleet payout') ? this.notice : 'Rested 8 hours · energy restored';
    this.save();
  }

  selectCar(id) {
    const p = this.profile;
    const car = CARS[id];
    if (!car || this.ride || id === p.car || (!p.owned[id] && p.balance < car.price)) return false;
    if (!p.owned[id]) {
      p.balance -= car.price;
      p.owned[id] = { fuel: capacity(car) / 4, level: 0, damage: 0 };
    }
    if (Boolean(car.battery) !== this.electric && this.target && this.target.type !== 'base') {
      p.service = null;
      this.route = [];
      this.routeIn = 0;
    }
    p.car = id;
    this.notice = `Driving ${car.name}`;
    this.save();
    return true;
  }

  buy(kind, driverIndex) {
    const p = this.profile;
    if (kind === 'homeCharger') {
      if (p.homeCharger || p.balance < HOME_CHARGER_COST) return false;
      p.balance -= HOME_CHARGER_COST;
      p.homeCharger = true;
      this.save();
      return true;
    }
    const driver = p.drivers[driverIndex];
    const levels = { car: this.vehicle.level, endurance: p.endurance, driver: driver?.level };
    const level = levels[kind];
    const cost = kind === 'hire' ? HIRE_PRICE : kind === 'robot' ? ROBOT_PRICE : upgradePrice(level);
    if (!Number.isFinite(cost) || p.balance < cost || level >= 3 || (kind === 'car' && this.ride) || (kind === 'hire' && p.drivers.length >= 8)) return false;
    p.balance -= cost;
    if (kind === 'car') this.vehicle.level++;
    if (kind === 'endurance') p.endurance++;
    if (kind === 'driver') driver.level++;
    if (kind === 'hire') p.drivers.push({ level: 0, worked: 0, awake: 0, resting: 0 });
    if (kind === 'robot') p.robots++;
    this.save();
    return true;
  }

  recover() {
    const p = this.profile;
    p.balance -= 15;
    p.ride = null;
    p.service = null;
    this.decline();
    this.route = [];
    this.vehicle.fuel = Math.max(this.vehicle.fuel, 0.75);
    this.notice = 'Roadside recovery to the garage · up to $15';
    this.lastPos = null;
    p.location = this.city.home.center;
    this.save();
  }
}
