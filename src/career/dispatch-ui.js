import { CARS, FUEL_PRICE, CHARGE_PRICE, HOME_CHARGE_PRICE, HOME_CHARGER_COST, HIRE_PRICE, ROBOT_PRICE } from './vehicles.js';
import { money, shiftLength, upgradePrice } from './career.js';
import { distance } from './city.js';
import { Showroom } from './showroom.js';

const venue = (stop) => stop.name.replace(` · ${stop.address}`, '');
const kinds = {
  regular: ['City ride', 'Pick up the rider and take them to their destination.'],
  tour: ['Scenic ride', 'Show the rider a city attraction on the way to their destination.'],
  express: ['Thrill ride', '$25 tip for reaching 58 km/h and finishing within the limit without damage or tickets.'],
};

const ICONS = {
  rides: '<path d="M5 15l1.6-4.6A2 2 0 0 1 8.5 9h7a2 2 0 0 1 1.9 1.4L19 15"/><rect x="3.5" y="15" width="17" height="4" rx="1.5"/><circle cx="7.5" cy="19.5" r="1.3"/><circle cx="16.5" cy="19.5" r="1.3"/><path d="M12 3.5v3"/>',
  nav: '<path d="M12 3l7.5 17-7.5-4-7.5 4z"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.2"/>',
  car: '<path d="M4.5 16a7.5 7.5 0 1 1 15 0"/><path d="M12 16l3.5-4.5"/><path d="M7 16h.01M17 16h.01"/>',
  garage: '<path d="M3 10.5L12 4l9 6.5V20H3z"/><path d="M7.5 20v-6h9v6"/><path d="M7.5 17h9"/>',
};
const APPS = [['rides', 'Rides'], ['nav', 'Navigate'], ['wallet', 'Wallet'], ['car', 'Car'], ['garage', 'Garage']];
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const clock = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const meter = (label, value, text, tone = '') => `<div class="ph-meter ${tone}"><div><span>${label}</span><b>${text}</b></div><i style="--v:${Math.round(Math.max(0, Math.min(1, value)) * 100)}%"></i></div>`;

/**
 * Driver phone: a portrait handset with a status bar (game clock, signal, driver energy as battery), five apps in a
 * fixed dock (Rides, Navigate, Wallet, Car, Garage) and a ride-offer card that works with the phone closed
 * (1 accept / 2 decline). It never takes keyboard focus, so driving keys (Space, arrows) keep driving.
 */
export class DispatchUI {
  constructor(career, act, materials) {
    this.career = career;
    this.act = act;
    this.showroom = new Showroom(materials);
    this.tab = 'cars';
    this.app = 'rides';
    this.selectedCar = career.profile.car;
    this.panel = document.createElement('aside');
    this.panel.id = 'dispatch';
    this.panel.setAttribute('aria-label', 'Driver phone');
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <div class="ph-offer" role="status" hidden></div>
      <button type="button" class="ph-peek" data-action="phone" aria-controls="driver-phone" aria-expanded="false">
        ${icon('rides')}<span>Phone</span><kbd>P</kbd><i class="ph-dot" hidden></i>
      </button>
      <div class="ph-handset" id="driver-phone" aria-hidden="true">
        <div class="ph-screen">
          <div class="ph-status"><span data-clock>00:00</span><span class="ph-island"></span><span class="ph-sys"><i class="ph-signal"><b></b><b></b><b></b><b></b></i><i class="ph-battery"><b data-battery></b></i></span></div>
          <header class="ph-head"><div><small data-sub>Meridian Rides</small><h2 data-title>Rides</h2></div><button type="button" data-action="phone" class="ph-close" aria-label="Put the phone away">${'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'}</button></header>
          <main class="ph-body" data-body></main>
          <nav class="ph-dock" aria-label="Apps">${APPS.map(([id, name]) => `<button type="button" data-action="app" data-value="${id}" aria-label="${name}">${icon(id)}<span>${name}</span></button>`).join('')}</nav>
          <div class="ph-hint"><kbd>Tab</kbd> next app · <kbd>P</kbd> put away</div>
        </div>
      </div>
    `;
    this.garage = document.createElement('dialog');
    this.garage.id = 'career-garage';
    this.garage.setAttribute('aria-label', 'Garage and fleet');
    this.rest = document.createElement('div');
    this.rest.id = 'career-rest';
    this.rest.setAttribute('role', 'status');
    this.rest.hidden = true;
    document.body.append(this.panel, this.garage, this.rest);
    const q = (sel) => this.panel.querySelector(sel);
    this.handset = q('.ph-handset');
    this.peek = q('.ph-peek');
    this.dot = q('.ph-dot');
    this.offerCard = q('.ph-offer');
    this.el = { clock: q('[data-clock]'), battery: q('[data-battery]'), title: q('[data-title]'), sub: q('[data-sub]'), body: q('[data-body]') };
    this.dockButtons = [...this.panel.querySelectorAll('.ph-dock button')];
    // pointer clicks must not move keyboard focus onto a button: Space (handbrake) would then "click" it again
    this.panel.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
    this.panel.addEventListener('click', (event) => this.action(event));
    this.garage.addEventListener('click', (event) => this.action(event));
    this.garage.addEventListener('cancel', (event) => { event.preventDefault(); act('closeGarage'); });
    this.cache = {};
    this.selectApp('rides');
  }

  get open() { return this.handset.classList.contains('open'); }

  action(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, value } = button.dataset;
    if (action === 'app') this.selectApp(value);
    else if (action === 'openOffer') this.togglePhone(true);
    else if (action === 'garageTab') {
      this.tab = value;
      this.renderGarage();
      this.garage.querySelector('[aria-current="page"]')?.focus();
    } else if (action === 'previewCar') {
      this.selectedCar = value;
      this.renderGarage();
      this.garage.querySelector('.garage-car.is-selected')?.focus();
    } else this.act(action, value);
  }

  show(visible) { this.panel.hidden = !visible; }

  togglePhone(open = !this.open) {
    this.handset.classList.toggle('open', open);
    this.handset.setAttribute('aria-hidden', String(!open));
    this.peek.setAttribute('aria-expanded', String(open));
    this.peek.classList.toggle('is-open', open);
    if (open && this.career.offer) this.selectApp('rides');
    this.cache.body = null;
  }

  selectApp(id) {
    if (id === 'garage') { this.act('garage'); return; }
    this.app = id;
    for (const b of this.dockButtons) b.setAttribute('aria-current', String(b.dataset.value === id));
    this.cache.body = null;
  }

  nextApp() {
    if (!this.open) return;
    const ids = APPS.map(([id]) => id).filter((id) => id !== 'garage');
    this.selectApp(ids[(ids.indexOf(this.app) + 1) % ids.length]);
  }

  setText(key, el, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el.textContent = value;
  }

  setHTML(key, el, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el.innerHTML = value;
  }

  update(pos, speed) {
    const c = this.career, p = c.profile, offer = c.offer;
    // offer card (phone closed) and unread dot
    this.dot.hidden = !offer || this.open;
    if (offer && !this.open) {
      const pickup = c.city.stops[offer.pickup];
      const left = Math.max(0, offer.seconds ?? 0);
      this.setHTML('offer', this.offerCard, `<div class="ph-offer-top">${icon('rides')}<span>New ride request</span><strong>${money(offer.fare)}</strong></div>
        <p>${kinds[offer.kind][0]} · pick up ${offer.rider} ${Math.round(distance(pos, pickup) / 10) * 10} m away · ${(offer.km).toFixed(1)} km trip</p>
        <div class="ph-offer-keys"><button type="button" data-action="accept"><kbd>1</kbd> Accept</button><button type="button" data-action="decline"><kbd>2</kbd> Decline</button><button type="button" data-action="openOffer">Details</button></div>
        <i class="ph-timer" style="--t:${Math.round(left)}s"></i>`);
      this.offerCard.style.setProperty('--left', String(Math.min(1, left / 20)));
      this.offerCard.hidden = false;
    } else this.offerCard.hidden = true;
    if (!this.open) return;

    this.setText('clock', this.el.clock, clock(c.time));
    this.el.battery.style.width = `${Math.round(c.energy * 100)}%`;
    this.el.battery.classList.toggle('low', c.energy < 0.2);
    const titles = { rides: ['Meridian Rides', c.ride ? 'On a ride' : offer ? 'Ride request' : c.energy <= 0.07 ? 'Off duty' : 'Online'], nav: ['Navigation', c.target ? 'Route active' : 'Where to?'], wallet: ['Wallet', money(p.balance)], car: [c.car.name, 'Vehicle'] };
    const [sub, title] = titles[this.app];
    this.setText('sub', this.el.sub, sub);
    this.setText('title', this.el.title, title);
    this.setHTML('body', this.el.body, this[`render_${this.app}`](pos, speed));
  }

  render_rides(pos) {
    const c = this.career, p = c.profile, offer = c.offer, target = c.target;
    if (offer) {
      const pickup = c.city.stops[offer.pickup], end = c.city.stops[offer.dropoff];
      const [title, details] = kinds[offer.kind];
      const scenic = offer.scenic == null ? '' : `<p class="ph-note">Via ${c.city.stops[offer.scenic].name}</p>`;
      return `<div class="ph-card ph-fare"><span>${title}</span><strong>${money(offer.fare)}</strong><small>${Math.max(0, Math.round(offer.seconds ?? 0))} s to respond</small></div>
        <ol class="ph-route">
          <li><small>Pick up ${offer.rider} · ${Math.round(distance(pos, pickup) / 10) * 10} m</small><b>${venue(pickup)}</b><span>${pickup.address}</span></li>
          <li><small>Drop off · ${(offer.km * 1000).toFixed(0)} m trip</small><b>${venue(end)}</b><span>${end.address}</span></li>
        </ol>${scenic}<p class="ph-note">${details}</p>
        <div class="ph-actions two"><button type="button" data-action="decline"><kbd>2</kbd> Decline</button><button type="button" class="ph-primary" data-action="accept"><kbd>1</kbd> Accept</button></div>`;
    }
    if (target && c.ride && p.service === null) {
      const ride = c.ride;
      const task = ride.phase === 'pickup' ? `Pick up ${ride.rider}` : ride.scenic != null ? 'Scenic checkpoint' : `Drop off ${ride.rider}`;
      return `<div class="ph-card ph-fare"><span>${task}</span><strong>${money(ride.fare)}</strong><small>${Math.round(distance(pos, target) / 10) * 10} m to go</small></div>
        <ol class="ph-route single"><li><small>${ride.phase === 'pickup' ? 'Pickup' : 'Destination'}</small><b>${venue(target)}</b><span>${target.address}</span></li></ol>
        <p class="ph-note">Follow the blue route and stop inside the road marker.${ride.kind === 'express' ? ' Thrill ride: $25 bonus available.' : ''}</p>
        <div class="ph-actions"><button type="button" data-action="cancelRide">Cancel ride</button></div>`;
    }
    if (c.vehicle.fuel <= 0.01) return `<div class="ph-empty"><b>${c.electric ? 'Battery empty' : 'Out of fuel'}</b><p>Use a nearby station or call roadside recovery.</p></div><div class="ph-actions"><button type="button" data-action="recover">Roadside recovery · $15</button></div>`;
    if (c.energy <= 0.07) return `<div class="ph-empty"><b>Off duty</b><p>You're too tired for new rides. Go home and sleep.</p></div><div class="ph-actions"><button type="button" data-action="home">Navigate home</button></div>`;
    return `<div class="ph-empty"><span class="ph-pulse"></span><b>Waiting for riders</b><p>Keep driving. Requests appear here and as a card at the top right.</p></div>
      <div class="ph-stats"><div><b>${p.completed}</b><small>rides done</small></div><div><b>${money(p.balance)}</b><small>balance</small></div></div>`;
  }

  render_nav(pos) {
    const c = this.career, target = c.target;
    const cur = target ? `<div class="ph-card"><span>${c.profile.service !== null ? 'Navigating to' : 'Ride destination'}</span><b>${venue(target)}</b><small>${target.address} · ${Math.round(distance(pos, target) / 10) * 10} m</small></div>` : '';
    const station = c.electric ? 'Nearest charger' : 'Nearest fuel';
    return `${cur}<div class="ph-list">
      <button type="button" data-action="fuel">${icon('car')}<span><b>${station}</b><small>${c.electric ? 'Public charging' : 'Gas station'} · fastest route</small></span></button>
      <button type="button" data-action="home">${icon('garage')}<span><b>Home</b><small>Sleep, home charger and garage</small></span></button>
      ${c.profile.service !== null ? `<button type="button" data-action="cancelNav">${icon('nav')}<span><b>Cancel navigation</b><small>Clear the blue route</small></span></button>` : ''}
    </div>`;
  }

  render_wallet() {
    const c = this.career, p = c.profile;
    const rows = (p.ledger || []).slice(0, 8).map((e) => `<li><span>${e.label}<small>${clock(e.hours ?? 0)}</small></span><b class="${e.amount >= 0 ? 'in' : 'out'}">${e.amount >= 0 ? '+' : '−'}$${Math.abs(e.amount).toFixed(2)}</b></li>`).join('');
    return `<div class="ph-card ph-balance"><span>Balance</span><strong class="${p.balance < 0 ? 'neg' : ''}">${money(p.balance)}</strong><small>${p.completed} rides · ${p.drivers.length} drivers · ${p.robots} shuttles</small></div>
      <h3 class="ph-sub">Recent activity</h3><ul class="ph-ledger">${rows || '<li class="none">No transactions yet.</li>'}</ul>`;
  }

  render_car(pos, speed) {
    const c = this.career, p = c.profile;
    const at = c.serviceAt(pos, speed);
    const fuel = c.vehicle.fuel / c.capacity, cond = 1 - (c.vehicle.damage ?? 0);
    let actions = '';
    if (at) {
      const label = at.type === 'fuel' ? `Refuel · ${money(FUEL_PRICE)}/L` : at.type === 'charge' ? `Charge · ${money(CHARGE_PRICE)}/kWh` : 'Sleep 8 hours';
      actions += `<button type="button" class="ph-primary" data-action="service"><kbd>F</kbd> ${label}</button>`;
      if (at.type === 'base' && c.electric && p.homeCharger) actions += `<button type="button" data-action="homeCharge">Home charge · ${money(HOME_CHARGE_PRICE)}/kWh</button>`;
    }
    if (c.vehicle.fuel <= 0.01) actions += '<button type="button" data-action="recover">Roadside recovery · $15</button>';
    return `${meter(c.electric ? 'Battery' : 'Fuel', fuel, `${c.vehicle.fuel.toFixed(1)} / ${c.capacity} ${c.unit}`, fuel < 0.15 ? 'warn' : '')}
      ${meter('Condition', cond, `${Math.round(cond * 100)}%`, cond < 0.5 ? 'warn' : '')}
      ${meter('Driver energy', c.energy, `${Math.round(c.energy * 100)}%`, c.energy < 0.2 ? 'warn' : '')}
      <p class="ph-note">${c.repairCost ? `Repairs quoted at ${money(c.repairCost)} in the garage workshop.` : 'No repairs needed.'} Performance level ${c.vehicle.level ?? 0} / 3.</p>
      ${actions ? `<div class="ph-actions">${actions}</div>` : ''}`;
  }

  renderGarage() {
    const c = this.career, p = c.profile;
    const button = (action, label, disabled, value = '') => `<button data-action="${action}" data-value="${value}" ${disabled ? 'disabled' : ''}>${label}</button>`;
    const car = CARS[this.selectedCar];
    const owned = p.owned[this.selectedCar];
    const active = this.selectedCar === p.car;
    const label = active ? 'Current vehicle' : owned ? 'Drive this car' : `Buy for ${money(car.price)}`;
    const cars = Object.entries(CARS).map(([id, item]) => `
      <button class="garage-car ${id === this.selectedCar ? 'is-selected' : ''}" data-action="previewCar" data-value="${id}" aria-pressed="${id === this.selectedCar}">
        <span class="garage-swatch" style="--car-color:${item.color}"></span><span>${item.name}</span>
        <small>${p.car === id ? 'Equipped' : p.owned[id] ? 'Owned' : money(item.price)}</small>
      </button>`).join('');
    const specs = car.battery
      ? [['Battery', `${car.battery} kWh`], ['Consumption', `${Math.round(car.kwhKm * 1000)} Wh/km`]]
      : [['Tank', `${car.tank} L`], ['City mileage', `${car.mpg} MPG`]];
    const upgrade = (kind, level, index) => button(kind, level >= 3 ? 'Fully upgraded' : `Upgrade · ${money(upgradePrice(level))}`, level >= 3 || p.balance < upgradePrice(level) || (kind === 'car' && Boolean(c.ride)), index);
    const staff = p.drivers.map((driver, index) => `<article><div><strong>Driver ${index + 1}</strong><small>Level ${driver.level + 1} · ${driver.resting > 0 ? `Resting · ${driver.resting.toFixed(1)} hours left` : `${Math.max(0, shiftLength(driver) - driver.awake).toFixed(1)} shift hours left`}</small></div>${upgrade('driver', driver.level, index)}</article>`).join('');
    const content = {
      cars: `<div class="garage-showroom">
        <div class="garage-preview"><div data-showroom></div><span>Drag to rotate</span></div>
        <div class="garage-details"><p class="garage-powertrain">${car.battery ? 'Electric' : 'Combustion'}</p><h3>${car.name}</h3>
          <dl>${specs.map(([key, value]) => `<div><dt>${key}</dt><dd>${value}</dd></div>`).join('')}
          <div><dt>Performance</dt><dd>${owned?.level ?? 0} / 3</dd></div></dl>
          ${button('select', label, active || Boolean(c.ride) || (!owned && p.balance < car.price), this.selectedCar)}
          ${c.ride ? '<p>Finish your ride to switch cars.</p>' : ''}
        </div>
      </div><div class="garage-carousel" aria-label="Vehicles">${cars}</div>`,
      service: `<div class="garage-work"><h3>Workshop</h3>
        <p>${p.incidents ?? 0} road incidents · ${money(p.roadCosts ?? 0)} in fines and liability</p>
        <article><div><strong>Body and mechanical repair</strong><small>${Math.round(100 - (c.vehicle.damage ?? 0) * 100)}% condition</small></div>${button('repair', c.repairCost ? `Repair · ${money(c.repairCost)}` : 'No repairs needed', !c.repairCost || p.balance < c.repairCost)}</article>
        <article><div><strong>Home EV charger</strong><small>${money(HOME_CHARGE_PRICE)}/kWh at your apartment · public charging ${money(CHARGE_PRICE)}/kWh</small></div>${button('homeCharger', p.homeCharger ? 'Installed' : `Install · ${money(HOME_CHARGER_COST)}`, p.homeCharger || p.balance < HOME_CHARGER_COST)}</article>
        <article><div><strong>Performance</strong><small>Increase acceleration and grip on your current car.</small></div>${upgrade('car', c.vehicle.level)}</article>
        <article><div><strong>Driver endurance</strong><small>Extend your shift by two hours.</small></div>${upgrade('endurance', p.endurance)}</article></div>`,
      fleet: `<div class="garage-work"><h3>Fleet</h3><p>Drivers come with leased cars. Your share is paid at midnight.</p>
        ${staff}
        <article><div><strong>Hire a driver</strong><small>${p.drivers.length}/8 drivers · starts at $5 per worked hour</small></div>${button('hire', `Hire · ${money(HIRE_PRICE)}`, p.drivers.length >= 8 || p.balance < HIRE_PRICE)}</article>
        <article><div><strong>Autonomous shuttle</strong><small>${p.robots} active · $260 per day each</small></div>${button('robot', `Buy · ${money(ROBOT_PRICE)}`, p.balance < ROBOT_PRICE)}</article></div>`,
    };
    this.garage.innerHTML = `
      <header class="garage-main-header"><div><h2>Meridian Garage</h2><p>${p.completed} rides completed</p></div>
      <div class="garage-wallet"><strong>${money(p.balance)}</strong>${button('closeGarage', 'Back to road')}</div></header>
      <nav class="garage-tabs" aria-label="Garage sections">${[['cars', 'Vehicles'], ['service', 'Workshop'], ['fleet', 'Fleet']].map(([value, title]) =>
        `<button data-action="garageTab" data-value="${value}" ${this.tab === value ? 'aria-current="page"' : ''}>${title}</button>`).join('')}</nav>
      ${content[this.tab]}`;
    const host = this.garage.querySelector('[data-showroom]');
    if (host) this.showroom.attach(host, car, owned?.paint ?? car.color);
    else this.showroom.detach();
  }

  openGarage() {
    this.selectedCar = this.career.profile.car;
    this.tab = 'cars';
    this.garage.showModal();
    this.renderGarage();
    this.garage.querySelector('[data-action="closeGarage"]')?.focus();
  }

  closeGarage() {
    this.showroom.detach();
    this.garage.close();
  }

  showRest(elapsed) {
    this.rest.hidden = elapsed === null;
    if (elapsed === null) return;
    const text = elapsed < 1.8 ? 'Walking home' : elapsed < 3.6 ? 'Sleeping · 8 hours' : 'Next shift · Full energy';
    if (this.rest.textContent !== text) this.rest.textContent = text;
  }
}
