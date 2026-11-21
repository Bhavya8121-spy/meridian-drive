// Main menu, pause menu, settings (graphics/audio/driving/world) and controls screens.
import { QUALITY } from '../core/settings.js';
import { DRIVING_PRESETS } from '../vehicle/specs.js';
import { WEATHER } from '../world/environment.js';

const $ = (id) => document.getElementById(id);
export const PAINTS = ['#b0121b', '#0f1115', '#e9ecef', '#1e4fa8', '#c48a12', '#2b5f3f', '#7a7f87', '#5b2a86'];

export class Menus {
  constructor(settings, handlers) {
    this.s = settings;
    this.h = handlers;
    this.stack = [];
    this.screens = { main: $('menu-main'), pause: $('menu-pause'), settings: $('menu-settings'), controls: $('menu-controls') };
    for (const [name, el] of Object.entries(this.screens)) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (b) this.action(b.dataset.act, name);
      });
    }
    // paint swatches
    const sw = $('swatches');
    for (const c of PAINTS) {
      const b = document.createElement('button');
      b.className = 'swatch' + (c === settings.get('paint') ? ' sel' : '');
      b.style.background = c;
      b.setAttribute('aria-label', 'Paint ' + c);
      b.addEventListener('click', () => {
        sw.querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        settings.set('paint', c);
      });
      sw.appendChild(b);
    }
    const qt = $('q-time'), qw = $('q-weather');
    qw.value = settings.get('weather');
    const t0 = settings.get('timeOfDay');
    qt.value = [...qt.options].reduce((a, o) => (Math.abs(+o.value - t0) < Math.abs(+a - t0) ? o.value : a), qt.options[0].value);
    qt.addEventListener('change', () => this.h.setTime(parseFloat(qt.value)));
    qw.addEventListener('change', () => settings.set('weather', qw.value));
    this.tab = 'graphics';
    this.buildSettings();
  }

  get open() { return this.stack.length > 0; }
  top() { return this.stack[this.stack.length - 1]; }

  show(name) {
    for (const el of Object.values(this.screens)) el.hidden = true;
    if (name) this.screens[name].hidden = false;
    const first = name && this.screens[name].querySelector('button.primary, button');
    first?.focus({ preventScroll: true });
  }
  push(name) { this.stack.push(name); this.show(name); }
  pop() { this.stack.pop(); this.show(this.top()); }
  clear() { this.stack = []; this.show(null); }

  action(act, from) {
    switch (act) {
      case 'drive': this.clear(); this.h.drive(); break;
      case 'resume': this.clear(); this.h.resume(); break;
      case 'reset': this.clear(); this.h.resume(); this.h.reset(); break;
      case 'settings': this.buildSettings(); this.push('settings'); break;
      case 'controls': this.push('controls'); break;
      case 'quit': this.clear(); this.h.quit(); break;
      case 'back': this.pop(); break;
    }
  }

  /** Esc handling: returns true if the menu consumed it. */
  escape() {
    if (!this.open) return false;
    const t = this.top();
    if (t === 'main') return true;
    if (t === 'pause') { this.clear(); this.h.resume(); return true; }
    this.pop();
    return true;
  }

  buildSettings() {
    const tabs = { graphics: 'Graphics', audio: 'Audio', driving: 'Driving', world: 'World' };
    const tabEl = $('set-tabs');
    tabEl.innerHTML = '';
    for (const [k, label] of Object.entries(tabs)) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = k === this.tab ? 'sel' : '';
      b.addEventListener('click', () => { this.tab = k; this.buildSettings(); });
      tabEl.appendChild(b);
    }
    const body = $('set-body');
    body.innerHTML = '';
    const s = this.s;
    const row = (label, control, val = '') => {
      const r = document.createElement('div');
      r.className = 'row';
      const l = document.createElement('label'); l.textContent = label;
      const v = document.createElement('span'); v.className = 'val'; v.textContent = val;
      r.append(l, control, v);
      body.appendChild(r);
      return v;
    };
    const select = (key, opts, onChange) => {
      const el = document.createElement('select');
      for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; el.appendChild(o); }
      el.value = String(s.get(key));
      el.addEventListener('change', () => { (onChange || ((v) => s.set(key, v)))(el.value); if (key === 'quality') this.buildSettings(); });
      return el;
    };
    const check = (key) => {
      const el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!s.get(key);
      el.addEventListener('change', () => s.set(key, el.checked));
      return el;
    };
    const slider = (key, min, max, step, fmt = (v) => v) => {
      const el = document.createElement('input'); el.type = 'range'; el.min = min; el.max = max; el.step = step; el.value = s.get(key);
      let valEl;
      el.addEventListener('input', () => { s.set(key, parseFloat(el.value)); valEl.textContent = fmt(parseFloat(el.value)); });
      return [el, (v) => (valEl = v), fmt(s.get(key))];
    };
    const sliderRow = (label, key, min, max, step, fmt) => { const [el, bind, txt] = slider(key, min, max, step, fmt); bind(row(label, el, txt)); };
    const pct = (v) => Math.round(v * 100) + '%';

    if (this.tab === 'graphics') {
      row('Quality preset', select('quality', Object.entries(QUALITY).map(([k, q]) => [k, q.label])));
      sliderRow('Render scale', 'renderScale', 0.7, 1, 0.05, pct);
      row('Dynamic resolution', check('dynamicRes'));
      row('Ambient occlusion (GTAO)', check('ao'));
      row('Bloom', check('bloom'));
      sliderRow('Traffic density', 'trafficDensity', 0, 1.5, 0.05, pct);
      row('Performance overlay (F3)', check('showFps'));
      const n = document.createElement('p'); n.className = 'note';
      n.textContent = 'Quality sets shadow-map resolution and distance, pooled street-light count, grass and draw distance. Lower the render scale first if the frame rate drops.';
      body.appendChild(n);
    } else if (this.tab === 'audio') {
      sliderRow('Master', 'masterVolume', 0, 1, 0.01, pct);
      sliderRow('Engine', 'engineVolume', 0, 1, 0.01, pct);
      sliderRow('Effects', 'sfxVolume', 0, 1, 0.01, pct);
      sliderRow('Ambience', 'ambienceVolume', 0, 1, 0.01, pct);
    } else if (this.tab === 'driving') {
      row('Handling model', select('drivingPreset', Object.entries(DRIVING_PRESETS).map(([k, p]) => [k, p.label])));
      sliderRow('Steering sensitivity', 'steerSensitivity', 0.5, 1.6, 0.05, (v) => v.toFixed(2) + '×');
      row('Speed units', select('units', [['kmh', 'km/h'], ['mph', 'mph']]));
      const n = document.createElement('p'); n.className = 'note';
      n.textContent = 'Arcade: high grip, strong stability and counter-steer assist, easy drifts. Balanced: traction control, ABS and light stability control. Simulation: no assists, wheelspin and lock-ups are yours to manage.';
      body.appendChild(n);
    } else {
      const [el, bind] = slider('timeOfDay', 0, 23.99, 0.05, fmtTime);
      el.addEventListener('input', () => this.h.setTime(parseFloat(el.value)));
      el.value = this.h.getTime();
      bind(row('Menu lighting', el, fmtTime(this.h.getTime())));
      sliderRow('Menu time speed', 'timeSpeed', 0, 20, 0.5, (v) => (v === 0 ? 'Paused' : v + '×'));
      row('Weather', select('weather', Object.entries(WEATHER).map(([k, w]) => [k, w.label])));
    }
  }
}

function fmtTime(v) {
  const h = Math.floor(v), m = Math.floor((v - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
